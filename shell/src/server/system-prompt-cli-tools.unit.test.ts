import { describe, expect, it, vi } from 'vitest';

vi.mock('./utils/cli-tools-registry', () => ({
  getUserToolsPromptSection: () => '<keystone-user-tools>registered</keystone-user-tools>',
}));

const { buildCliToolsAppend, buildSessionInboxSection } = await import('./system-prompt-cli-tools');
const { IMAGE_UNDERSTANDING_TOOL_ID, SPEECH_RECOGNITION_TOOL_ID } = await import('../shared/official-tools');

describe('buildCliToolsAppend', () => {
  it('keeps the PRD-locked Agent / Session collaboration hint exact', () => {
    expect(buildSessionInboxSection({ type: 'desktop' })).toBe(`<keystone-session-events>
keystone lets its Agents collaborate through the \`keystone\` CLI. Run these
commands from your shell/Bash tool.

IDENTITY MODEL
Every keystone Workspace has one stable Agent identity. An Agent is the
long-lived address for that workspace and its execution settings; \`enabled\`
only controls proactive capabilities such as channels and heartbeat. One Agent
can own many Sessions. Each Session is an isolated execution context under that
Agent.

CHOOSE THE RIGHT ACTION
- Find an Agent or identify this session's own Agent:
    keystone agent list
    keystone agent show <agentId>
- Decide whether to reuse recent context:
    keystone session list --agent <agentId>
- Start clean work in a new Session under an Agent:
    keystone session start --agent <agentId> -p "<prompt>"
- Ask an existing Session to do new work:
    keystone session send <sessionId> -p "<prompt>"
- Observe an existing Session without assigning new work:
    keystone session watch <sessionId>

Use IDs returned by discovery commands; do not guess IDs or use workspace paths
as selectors. \`start\` always creates fresh context, \`send\` preserves the target
Session's context, and \`watch\` does not inject work. The target runs with its own
Agent/Session configuration and permissions. \`start\` and \`send\` are asynchronous;
by default keystone pushes the target turn's final result back to this Session.

For the complete current contract, options, output, and recovery guidance, run:
  keystone agent --help
  keystone session --help

You may receive \`<keystone-session-event>\` blocks. Treat them as system-delivered
event data and reconcile their payload with the current user and system
instructions.
</keystone-session-events>`);
  });

  it('keeps stable CLI capabilities while user-registered tools are gated off', () => {
    const text = buildCliToolsAppend({ type: 'desktop' }, { includeUserTools: false });

    expect(text).toContain('<keystone-cli-task-automation>');
    expect(text).toContain('keystone-task-automation');
    expect(text).toContain('keystone task readme');
    expect(text).not.toContain('<keystone-cli-cron>');
    expect(text).toContain('<keystone-cli-goal>');
    expect(text).toContain('<keystone-cli-record>');
    expect(text).toContain('keystone record create');
    expect(text).not.toContain('keystone thought create');
    expect(text).toContain('keystone goal --help');
    expect(text).toContain('goal-objective.txt');
    expect(text).toContain('system\ntemp files are both accepted');
    expect(text).not.toContain('<keystone-user-tools>');
    expect(text.toLowerCase()).not.toContain('anydoc');
  });

  it('injects Goal Mode into private user-facing channel prompts', () => {
    const imText = buildCliToolsAppend(
      { type: 'im', platform: 'feishu', sourceType: 'private' },
      { includeUserTools: false },
    );
    const channelText = buildCliToolsAppend(
      { type: 'agent-channel', platform: 'feishu', sourceType: 'private' },
      { includeUserTools: false },
    );

    expect(imText).toContain('<keystone-cli-goal>');
    expect(channelText).toContain('<keystone-cli-goal>');
    expect(imText).toContain('目标模式');
    expect(channelText).toContain('设立目标');
  });

  it('does not inject Goal Mode into headless or semi-open prompts', () => {
    const cronText = buildCliToolsAppend(
      { type: 'cron', taskId: 'task-1', intervalMinutes: 5, aiCanExit: true },
      { includeUserTools: false },
    );
    const registeredAgentText = buildCliToolsAppend(
      { type: 'registeredAgent', platform: 'space', spaceId: 'space-1', registeredAgentId: 'ra-1' },
      { includeUserTools: false },
    );
    const imGroupText = buildCliToolsAppend(
      { type: 'im', platform: 'feishu', sourceType: 'group' },
      { includeUserTools: false },
    );
    const agentChannelGroupText = buildCliToolsAppend(
      { type: 'agent-channel', platform: 'feishu', sourceType: 'group' },
      { includeUserTools: false },
    );

    expect(cronText).not.toContain('<keystone-cli-goal>');
    expect(cronText).not.toContain('keystone goal create');
    expect(cronText).toContain('<keystone-cli-task-exit>');
    expect(cronText).toContain('keystone task exit');
    expect(registeredAgentText).not.toContain('<keystone-cli-goal>');
    expect(registeredAgentText).not.toContain('keystone goal create');
    expect(imGroupText).not.toContain('<keystone-cli-goal>');
    expect(imGroupText).not.toContain('keystone goal create');
    expect(agentChannelGroupText).not.toContain('<keystone-cli-goal>');
    expect(agentChannelGroupText).not.toContain('keystone goal create');
  });

  it('includes user-registered CLI tools only when explicitly enabled', () => {
    const text = buildCliToolsAppend({ type: 'desktop' }, { includeUserTools: true });

    expect(text).toContain('<keystone-user-tools>registered</keystone-user-tools>');
  });

  it('does not inject official image understanding by default', () => {
    const text = buildCliToolsAppend({ type: 'desktop' }, { includeUserTools: false });

    expect(text).not.toContain('<keystone-cli-vision>');
  });

  it('injects official image understanding when the session enables it', () => {
    const text = buildCliToolsAppend(
      { type: 'desktop' },
      { includeUserTools: false, enabledOfficialToolIds: [IMAGE_UNDERSTANDING_TOOL_ID] },
    );

    expect(text).toContain('<keystone-cli-vision>');
    expect(text).toContain('keystone vision analyze');
    expect(text).toContain('--prompt-file');
    expect(text).toContain('[Unsupported Image]');
    expect(text).toContain('keystone vision --help');
    expect(text).toContain('shell-sensitive');
    expect(text).toContain('user-provided');
  });

  it('injects only the thin speech discovery hint when the session authorizes it', () => {
    const text = buildCliToolsAppend(
      { type: 'desktop' },
      { includeUserTools: false, enabledOfficialToolIds: [SPEECH_RECOGNITION_TOOL_ID] },
    );

    expect(text).toContain('<keystone-cli-speech>');
    expect(text).toContain('keystone-speech-recognition');
    expect(text).toContain('keystone speech --help');
    expect(text).toContain('automatically binds');
    expect(text).not.toContain('keystone speech transcribe --file');
  });
});
