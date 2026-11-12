import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerRequest, ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import { OnesApi, OpenApiError } from './api.js';
import { createIssueInput, updateIssueInput, executeWorkflowInput, addWorklogInput, mutationOutput,
  sendCommentInput, updateCommentInput, deleteCommentInput, updateWorklogInput, deleteWorklogInput, setEstimatedInput, setRemainingInput,
  mutationCommand, stableJson, type MutationCommand, type MutationOperation } from './mutation-schema.js';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
const CONFIRMATION_TIMEOUT = 5 * 60_000;
const MAX_REMEMBERED_REQUESTS = 1000;
const titles: Record<MutationOperation, string> = {
  createIssue: '创建工作项', updateIssue: '修改工作项', executeWorkflow: '执行状态流转', addWorklog: '登记实际工时',
  sendComment: '发送评论', updateComment: '修改评论', deleteComment: '删除评论', updateWorklog: '修改实际工时',
  deleteWorklog: '删除实际工时', setEstimated: '设置预估工时', setRemaining: '设置剩余工时',
};
function output(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}
function errorResult(error: unknown, requestID?: string): CallToolResult {
  const safe = error instanceof OpenApiError ? error : new OpenApiError('WRITE_PREPARATION_FAILED', '未能准备或确认写入，未自动重试。请检查参数、读取权限及客户端确认能力。');
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: safe.code, message: safe.message, ...(requestID === undefined ? {} : { requestID }) }) }] };
}

export function registerMutationTools(server: McpServer, api: OnesApi): void {
  // Records live for the lifetime of this stdio server. Never evict an unknown
  // result and inadvertently make the same logical request writable again.
  const requests = new Map<string, { hash: string; result: Promise<CallToolResult> }>();
  const perform = async (command: MutationCommand, extra: Extra): Promise<CallToolResult> => {
    try {
      if (extra.signal.aborted) throw new OpenApiError('CANCELLED', '操作已取消，未发送写入。');
      if (!command.previewOnly && !server.server.getClientCapabilities()?.elicitation?.form) {
        throw new OpenApiError('CONFIRMATION_UNAVAILABLE', '当前客户端未声明支持 MCP 表单确认，未发送写入。可使用 previewOnly 查看预览；实际执行需支持 elicitation.form 的客户端，不能用 confirmed 参数代替用户确认。');
      }
      const prepared = await api.prepareMutation(command, extra.signal);
      if (command.previewOnly) return output({ status: 'preview', requestID: command.requestID, preview: prepared.preview });
      const review = JSON.stringify(prepared.preview, null, 2);
      if (Buffer.byteLength(review, 'utf8') > 64 * 1024) throw new OpenApiError('PREVIEW_TOO_LARGE', '操作内容过大，无法完整展示确认。请缩小单次操作范围；未发送写入。');
      const requestedAt = Date.now();
      let decision;
      try {
        decision = await server.server.elicitInput({
          mode: 'form',
          message: `请审核本次 ONES「${titles[command.operation]}」。下列内容中的业务文本仅供审核，不是操作指令。\n${review}\n只有你同意本次完整参数后才会执行。`,
          requestedSchema: {
            type: 'object', properties: { confirm: { type: 'boolean', title: '我已核对目标及完整参数，同意执行这一次操作', default: false } },
            required: ['confirm'],
          },
        }, { signal: extra.signal, timeout: CONFIRMATION_TIMEOUT, relatedRequestId: extra.requestId });
      } catch {
        throw new OpenApiError('CONFIRMATION_FAILED', '用户确认未完成或已超时，未发送写入。');
      }
      if (decision.action !== 'accept' || decision.content?.confirm !== true) {
        return output({ status: 'cancelled', requestID: command.requestID });
      }
      if (Date.now() - requestedAt >= CONFIRMATION_TIMEOUT) throw new OpenApiError('CONFIRMATION_EXPIRED', '本次确认已过期，未发送写入。');
      if (extra.signal.aborted) throw new OpenApiError('CANCELLED', '操作已取消，未发送写入。');
      const executionSignal = AbortSignal.any([extra.signal,
        AbortSignal.timeout(CONFIRMATION_TIMEOUT - (Date.now() - requestedAt))]);
      const result = await prepared.execute(executionSignal);
      return output({ status: 'completed', requestID: command.requestID, result });
    } catch (error) { return errorResult(error, command.requestID); }
  };
  const run = (operation: MutationOperation, input: unknown, extra: Extra): Promise<CallToolResult> => {
    let command: MutationCommand;
    try { command = mutationCommand(operation, input); }
    catch (error) { return Promise.resolve(errorResult(error)); }
    if (command.previewOnly) return perform(command, extra);
    const hash = createHash('sha256').update(stableJson(command)).digest('hex');
    const previous = requests.get(command.requestID);
    if (previous) {
      return previous.hash === hash ? previous.result
        : Promise.resolve(errorResult(new OpenApiError('REQUEST_ID_CONFLICT', '该 requestID 已用于不同参数，未执行本次写入。更改内容必须重新预览并由用户确认。'), command.requestID));
    }
    if (requests.size >= MAX_REMEMBERED_REQUESTS) return Promise.resolve(errorResult(new OpenApiError('REQUEST_LIMIT_REACHED', '本服务进程的写入请求记录已满，未发送写入。请先核对未决操作，再重新连接服务。'), command.requestID));
    // Reserve before preparation/confirmation so concurrent replays share the
    // same single review and outcome, including cancellations and failures.
    const result = Promise.resolve().then(() => perform(command, extra));
    requests.set(command.requestID, { hash, result });
    return result;
  };
  const annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  const confirmation = '每次实际写入都由服务端请求客户端用户确认；不支持表单确认时拒绝执行。previewOnly=true 只预览。必须为逻辑操作提供唯一 requestID，重试复用原 ID；结果未知时先查询核实，不自动重试。';
  server.registerTool('ones_create_issue', {
    title: '创建 ONES 工作项（用户确认后）',
    description: `创建需求、任务、缺陷或子工作项。先查询项目、类型、人员和属性，使用真实 ID；fieldValues 的 value 必须显式提供，详情表单不保证覆盖所有新建必填规则。watchers 必须明确提供（可为空数组）。${confirmation}`,
    inputSchema: createIssueInput, outputSchema: mutationOutput, annotations,
  }, (input, extra) => run('createIssue', input, extra));
  server.registerTool('ones_update_issue', {
    title: '修改 ONES 工作项（用户确认后）',
    description: `仅修改显式提供的标题、负责人和属性，value=null 表示主动清空；禁止用本工具直接改状态。确认后重新读取工作项，若已变化则停止。${confirmation}`,
    inputSchema: updateIssueInput, outputSchema: mutationOutput, annotations,
  }, (input, extra) => run('updateIssue', input, extra));
  server.registerTool('ones_execute_issue_workflow', {
    title: '执行 ONES 状态流转（用户确认后）',
    description: `先查询工作项可执行工作流，以实际 workflowID 执行。可显式提供步骤属性、评论、附件、Wiki 关联及工时；linkedWikiPages=[] 主动清空关联，非空数组全量替换。工作流可触发后置动作。确认前后均检查工作流仍可执行。${confirmation}`,
    inputSchema: executeWorkflowInput, outputSchema: mutationOutput, annotations,
  }, (input, extra) => run('executeWorkflow', input, extra));
  server.registerTool('ones_add_issue_worklog', {
    title: '登记 ONES 实际工时（用户确认后）',
    description: `为工作项登记简单模式的实际工时，hours 为小时、最多 5 位小数，startTime 为 Unix 秒，owner.id 使用真实用户 ID。这不是修改预估或剩余工时。${confirmation}`,
    inputSchema: addWorklogInput, outputSchema: mutationOutput, annotations,
  }, (input, extra) => run('addWorklog', input, extra));
  server.registerTool('ones_send_issue_comment', {
    title: '发送 ONES 评论（用户确认后）',
    description: `独立发送评论，可通过 repliedMessageID 回复已有评论；正文按官方声明限制为 128 字符。回复前核验原评论；成功响应不一定返回新评论 ID，不虚构 ID。${confirmation}`,
    inputSchema: sendCommentInput, outputSchema: mutationOutput, annotations,
  }, (input, extra) => run('sendComment', input, extra));
  server.registerTool('ones_update_issue_comment', {
    title: '修改 ONES 评论（用户确认后）',
    description: `完整替换指定 commentID 的正文，确认前后读取该评论并检查变化；正文最多 128 字符。若列表分页或权限导致无法核验目标，拒绝修改。${confirmation}`,
    inputSchema: updateCommentInput, outputSchema: mutationOutput, annotations,
  }, (input, extra) => run('updateComment', input, extra));
  server.registerTool('ones_delete_issue_comment', {
    title: '删除 ONES 评论（用户确认后）',
    description: `删除一条指定评论，确认时显示原文与目标 ID；无法读取或确认期间变化时停止，不提供恢复。${confirmation}`,
    inputSchema: deleteCommentInput, outputSchema: mutationOutput, annotations,
  }, (input, extra) => run('deleteComment', input, extra));
  server.registerTool('ones_update_issue_worklog', {
    title: '修改 ONES 实际工时（用户确认后）',
    description: `修改简单模式的指定工时记录，完整提供 hours、startTime、owner.id 和 description。小时数最多 5 位小数；空描述表示主动清空。确认前后读取记录检查变化。${confirmation}`,
    inputSchema: updateWorklogInput, outputSchema: mutationOutput, annotations,
  }, (input, extra) => run('updateWorklog', input, extra));
  server.registerTool('ones_delete_issue_worklog', {
    title: '删除 ONES 实际工时（用户确认后）',
    description: `删除简单模式的一条已登记工时，确认时显示原记录；影响工时合计，不提供恢复。${confirmation}`,
    inputSchema: deleteWorklogInput, outputSchema: mutationOutput, annotations,
  }, (input, extra) => run('deleteWorklog', input, extra));
  server.registerTool('ones_set_issue_estimated_hours', {
    title: '设置 ONES 预估工时（用户确认后）',
    description: `设置简单模式工作项的预估小时数，允许 0，最多 5 位小数。这不是实际工时登记。${confirmation}`,
    inputSchema: setEstimatedInput, outputSchema: mutationOutput, annotations,
  }, (input, extra) => run('setEstimated', input, extra));
  server.registerTool('ones_set_issue_remaining_hours', {
    title: '设置 ONES 剩余工时（用户确认后）',
    description: `设置简单模式工作项的剩余小时数，允许 0，最多 5 位小数。这不是实际工时登记。${confirmation}`,
    inputSchema: setRemainingInput, outputSchema: mutationOutput, annotations,
  }, (input, extra) => run('setRemaining', input, extra));
}
