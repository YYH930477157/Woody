import { ipcBridge } from '@/common';
import type { TeamAssistantInput } from '@/common/adapter/teamMapper';
import type { ModuleExpert } from '@/common/types/team/moduleExperts';
import type { TTeam } from '@/common/types/team/teamTypes';
import type { ExpertBrief } from './expertRules';

/**
 * The card state and brief digest of every expert, after Woody wrote the briefs that were
 * missing or outdated. Falls back to `fallback` (last loaded card states) on transient errors
 * so already-learned experts are not needlessly sent back to onboarding; returns undefined
 * when the project has no usable index.
 */
export async function loadExpertBriefs(
  workspace: string,
  language: string,
  fallback?: Record<string, ExpertBrief>
): Promise<Record<string, ExpertBrief> | undefined> {
  try {
    const cards = await ipcBridge.codebaseMemory.moduleCards.invoke({
      repoPath: workspace,
      refresh: true,
      ids: [],
      language,
    });
    return Object.fromEntries(cards.experts.map((card) => [card.id, { state: card.state, digest: card.digest }]));
  } catch {
    return fallback;
  }
}

/** Experts who learn their module when the team starts: every one whose card is not up to date. */
export function onboardingIds(experts: ModuleExpert[], briefs: Record<string, ExpertBrief> | undefined): string[] {
  return experts.filter((expert) => briefs?.[expert.id]?.state !== 'ready').map((expert) => expert.id);
}

/**
 * Ask each onboarding expert of a new team to learn its module, and the dispatcher to write
 * the business overview when `lead` is given. `agents` are the team's roles in order
 * (dispatcher, experts, verifier), so the dispatcher is agent 0 and the expert at index i is
 * agent i + 1. Resolves to the names of the members that could not be asked.
 */
export async function startOnboarding(params: {
  team: TTeam;
  agents: TeamAssistantInput[];
  experts: ModuleExpert[];
  ids: string[];
  knowledge: string;
  message: (card: string) => string;
  /** The dispatcher's name and the message that asks it to learn the business. */
  lead?: { name: string; message: string };
}): Promise<string[]> {
  const { team, agents, experts, ids, knowledge, message, lead } = params;
  const members = team.assistants ?? team.agents ?? [];
  const send = async (agent: TeamAssistantInput | undefined, label: string, input: string) => {
    const assistantId = agent?.assistant_id;
    const slot = members.find((member) => assistantId && member.assistant_id === assistantId)?.slot_id;
    if (!slot) throw new Error(`No team member for ${label}`);
    const ack = await ipcBridge.team.sendMessageToAgent.invoke({ team_id: team.id, slot_id: slot, input });
    // The platform bridge returns provider errors as a sentinel object.
    const failure = ack as unknown as { __bridgeError?: boolean; message?: string };
    if (failure?.__bridgeError) throw new Error(failure.message ?? 'send failed');
  };
  const asked = [
    ...(lead ? [{ name: lead.name, run: () => send(agents[0], 'the dispatcher', lead.message) }] : []),
    ...experts.flatMap((expert, index) =>
      ids.includes(expert.id)
        ? [
            {
              name: expert.name,
              run: () => send(agents[index + 1], expert.id, message(`${knowledge}/features/${expert.id}.md`)),
            },
          ]
        : []
    ),
  ];
  const results = await Promise.allSettled(asked.map((item) => item.run()));
  return asked.filter((_, index) => results[index].status === 'rejected').map((item) => item.name);
}
