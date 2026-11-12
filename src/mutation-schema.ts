import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const userID = id.max(8);
const common = {
  teamID: id,
  requestID: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/).describe('本次逻辑操作的唯一标识。重复调用必须复用；同一服务进程内不会重复写入。'),
  previewOnly: z.boolean().default(false).describe('为 true 时只读取并返回预览，不请求批准、不写入。'),
};
// value is deliberately required: omission must never silently clear a field.
const fieldValue = z.strictObject({
  fieldID: id.min(8), type: z.number().int().positive().optional(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.unknown()), z.record(z.string(), z.unknown())]),
});
const fieldValues = z.array(fieldValue).max(500).refine((values) => new Set(values.map((item) => item.fieldID)).size === values.length,
  '同一属性不能重复提交。');
const title = z.string().min(1).max(1024).refine((value) => value.trim().length > 0, '标题不能为空白。');
const timestamp = z.number().int().min(0).max(253402300799).describe('Unix 秒，必须由用户提供或明确核对，不接受毫秒时间戳。');
const hours = z.number().nonnegative().refine((value) => /^\d+(\.\d{1,5})?$/.test(String(value)), '小时数最多保留 5 位小数。');
const commentText = z.string().min(1).max(128).refine((value) => value.trim().length > 0, '评论不能为空白。');
export const createIssueInput = z.strictObject({ ...common,
  projectID: id.max(16), issueTypeID: id.max(8), assignee: userID, title,
  fieldValues, watchers: z.array(userID).max(100), parentID: id.max(16).optional(),
});
export const updateIssueInput = z.strictObject({ ...common, issueID: id,
  title: title.optional(), assignee: userID.optional(), fieldValues: fieldValues.optional(),
}).refine((input) => input.title !== undefined || input.assignee !== undefined || (input.fieldValues?.length ?? 0) > 0,
  '至少提供一项需要修改的内容。').refine((input) => !input.fieldValues?.some((field) => field.fieldID === 'field005' || field.type === 12),
  '修改状态必须使用工作流工具，不能直接更新状态属性。');
export const executeWorkflowInput = z.strictObject({ ...common, issueID: id, workflowID: id.max(8),
  fieldValues: fieldValues.optional(),
  comment: z.array(z.strictObject({ contentType: z.number().int().positive(), text: z.string().min(1).max(50000) })).max(100).optional(),
  resources: z.array(z.strictObject({ id })).max(100).optional(),
  linkedWikiPages: z.array(z.strictObject({ id: id.length(8), position: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })).max(500).nullable().optional(),
  timeEstimatedHour: z.strictObject({ hours: z.number().int().nonnegative() }).optional(),
  timeSpentHour: z.array(z.strictObject({ owner: userID, startTime: timestamp, hours: z.number().int().positive(),
    description: z.string().max(50000).optional() })).max(100).optional(),
});
export const addWorklogInput = z.strictObject({ ...common, issueID: id,
  hours: hours.refine((value) => value > 0, '实际工时必须大于零。'),
  startTime: timestamp, owner: z.strictObject({ id: userID }), description: z.string().max(50000).optional(),
});
export const sendCommentInput = z.strictObject({ ...common, issueID: id, text: commentText, repliedMessageID: id.optional() });
export const updateCommentInput = z.strictObject({ ...common, issueID: id, commentID: id, text: commentText });
export const deleteCommentInput = z.strictObject({ ...common, issueID: id, commentID: id });
export const updateWorklogInput = addWorklogInput.extend({ worklogID: id, description: z.string().max(50000) });
export const deleteWorklogInput = z.strictObject({ ...common, issueID: id, worklogID: id });
export const setEstimatedInput = z.strictObject({ ...common, issueID: id, hours });
export const setRemainingInput = setEstimatedInput;

export const mutationOperations = ['createIssue', 'updateIssue', 'executeWorkflow', 'addWorklog',
  'sendComment', 'updateComment', 'deleteComment', 'updateWorklog', 'deleteWorklog', 'setEstimated', 'setRemaining'] as const;
export type MutationOperation = typeof mutationOperations[number];
export interface MutationCommand {
  operation: MutationOperation; requestID: string; previewOnly: boolean;
  teamID: string; issueID?: string; projectID?: string; parentID?: string; workflowID?: string; commentID?: string; worklogID?: string; repliedMessageID?: string;
  method: 'POST' | 'PUT' | 'DELETE'; path: string; query: Record<string, string>; body: Record<string, unknown>;
}
export interface MutationPreview {
  operation: MutationOperation; requestID: string; site: string; actor: Record<string, unknown>;
  target: Record<string, unknown>; request: { method: string; url: string; body?: Record<string, unknown> }; notes: string[];
}
export interface PreparedMutation {
  preview: MutationPreview;
  execute(signal?: AbortSignal): Promise<Record<string, unknown>>;
}
export const mutationOutput = z.object({
  status: z.enum(['preview', 'cancelled', 'completed']), requestID: z.string(),
  preview: z.record(z.string(), z.unknown()).optional(), result: z.record(z.string(), z.unknown()).optional(),
});
export function mutationCommand(operation: MutationOperation, input: unknown): MutationCommand {
  const schemas = { createIssue: createIssueInput, updateIssue: updateIssueInput, executeWorkflow: executeWorkflowInput, addWorklog: addWorklogInput,
    sendComment: sendCommentInput, updateComment: updateCommentInput, deleteComment: deleteCommentInput,
    updateWorklog: updateWorklogInput, deleteWorklog: deleteWorklogInput, setEstimated: setEstimatedInput, setRemaining: setRemainingInput };
  const parsed = schemas[operation].parse(input);
  const { teamID, requestID, previewOnly, ...rest } = parsed;
  const body = { ...rest } as Record<string, unknown>;
  const issueID = 'issueID' in parsed ? parsed.issueID : undefined;
  delete body.issueID;
  delete body.commentID;
  delete body.worklogID;
  let path = '/project/issues';
  const query: Record<string, string> = { teamID };
  if (issueID !== undefined) path += `/${encodeURIComponent(issueID)}`;
  if (operation === 'executeWorkflow') { query.action = 'executeWorkflow'; body.id = body.workflowID; delete body.workflowID; }
  if (operation === 'addWorklog') path += '/workLog/simple/timesSpent';
  if (['sendComment', 'updateComment', 'deleteComment'].includes(operation)) {
    path += '/comments';
    if ('commentID' in parsed) path += `/${encodeURIComponent(parsed.commentID)}`;
  }
  if ('worklogID' in parsed) path += `/workLog/simple/timesSpent/${encodeURIComponent(parsed.worklogID)}`;
  if (operation === 'setEstimated') path += '/workLog/simple/timesEstimated';
  if (operation === 'setRemaining') path += '/workLog/simple/timesRemaining';
  return {
    operation, teamID, requestID, previewOnly, path, query, body,
    method: ['deleteComment', 'deleteWorklog'].includes(operation) ? 'DELETE'
      : ['updateIssue', 'updateComment', 'updateWorklog'].includes(operation) ? 'PUT' : 'POST',
    ...(issueID === undefined ? {} : { issueID }),
    ...('projectID' in parsed ? { projectID: parsed.projectID } : {}),
    ...('parentID' in parsed && parsed.parentID !== undefined ? { parentID: parsed.parentID } : {}),
    ...('workflowID' in parsed ? { workflowID: parsed.workflowID } : {}),
    ...('commentID' in parsed ? { commentID: parsed.commentID } : {}),
    ...('worklogID' in parsed ? { worklogID: parsed.worklogID } : {}),
    ...('repliedMessageID' in parsed && parsed.repliedMessageID !== undefined ? { repliedMessageID: parsed.repliedMessageID } : {}),
  };
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
