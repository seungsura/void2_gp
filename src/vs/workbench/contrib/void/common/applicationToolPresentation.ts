/* Application-owned tools must not borrow MCP presentation or stringify hooks. */
import { isReadSkillResourceToolName } from './agentSkills.js';
import { isAgentSubagentControlName } from './agentSubagents.js';

export type ApplicationToolPresentation = Readonly<{ title: string; status: string; paramsDetail: string; resultDetail?: string; error?: string }>;
export type ApplicationToolRoute = 'builtin' | 'application' | 'mcp';
const bounded = (value: unknown, limit = 240): string => {
	try { const text = typeof value === 'string' ? value : JSON.stringify(value); return text === undefined ? '[undefined]' : text.length === 0 ? '[empty]' : text.length > limit ? `${text.slice(0, limit - 3)}...` : text; }
	catch { return '[unavailable]'; }
};
export const isApplicationToolName = (name: string): boolean => isReadSkillResourceToolName(name) || isAgentSubagentControlName(name);
export const applicationToolRoute = (name: string, isBuiltin: boolean): ApplicationToolRoute => isBuiltin ? 'builtin' : isApplicationToolName(name) ? 'application' : 'mcp';
export const shouldOfferGenericToolApproval = (route: ApplicationToolRoute, type: string): boolean => type === 'tool_request' && route !== 'application';
export const applicationToolPresentation = (name: string, type: string, params: unknown, payload?: unknown): ApplicationToolPresentation | undefined => {
	if (!isApplicationToolName(name)) return undefined;
	const title = name === 'read_skill_resource' ? 'Read Skill resource' : name === 'spawn_agent' ? 'Start child Agent' : name === 'wait_agent' ? 'Wait for child Agent' : 'Interrupt child Agent';
	const status = type === 'running_now' ? 'Running' : type === 'success' ? 'Completed' : type === 'tool_error' ? 'Failed' : type === 'rejected' ? 'Rejected' : type === 'invalid_params' ? 'Invalid request' : type === 'interrupted_streaming_tool' ? 'Cancelled' : 'Requested';
	const paramsDetail = bounded(params);
	const resultDetail = type === 'success' ? bounded(payload) : undefined;
	const error = type === 'tool_error' || type === 'invalid_params' ? bounded(payload) : undefined;
	return Object.freeze({ title, status, paramsDetail, ...(resultDetail === undefined ? {} : { resultDetail }), ...(error === undefined ? {} : { error }) });
};
