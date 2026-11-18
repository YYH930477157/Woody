import { ipcBridge } from '@/common';
import type { TeamAssistantInput } from '@/common/adapter/teamMapper';
import type { ModuleExpert } from '@/common/types/team/moduleExperts';
import type { TTeam } from '@/common/types/team/teamTypes';
import type { ExpertBrief } from './expertRules';

/**
 * The card state and brief digest of every expert, after Woody wrote the briefs that were
 * missing or outdated. Undefined when the project has no usable index: the team then starts
 * without briefs and the experts learn their modules from the source.
 */
export async function loadExpertBriefs(
  workspace: string,
  language: string
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
    return undefined;
  }
}

/** Experts who learn their module when the team starts: every one whose card is not up to date. */
export function onboardingIds(experts: ModuleExpert[], briefs: Record<string, ExpertBrief> | undefined): string[] {
  return experts.filter((expert) => briefs?.[expert.id]?.state !== 'ready').map((expert) => expert.id);
}

/**
 * Ask each onboarding expert of a new team to learn its module. `agents` are the team's
 * roles in order (dispatcher, experts, verifier), so the expert at index i is agent i + 1.
 * Resolves to the names of the experts that could not be asked.
 */
export async function startOnboarding(params: {
  team: TTeam;
  agents: TeamAssistantInput[];
  experts: ModuleExpert[];
  ids: string[];
  knowledge: string;
  message: (card: string) => string;
}): Promise<string[]> {
  const { team, agents, experts, ids, knowledge, message } = params;
  const members = team.assistants ?? team.agents ?? [];
  const results = await Promise.allSettled(
    experts.map(async (expert, index) => {
      if (!ids.includes(expert.id)) return;
      const assistantId = agents[index + 1]?.assistant_id;
      const slot = members.find((member) => assistantId && member.assistant_id === assistantId)?.slot_id;
      if (!slot) throw new Error(`No team member for ${expert.id}`);
      const ack = await ipcBridge.team.sendMessageToAgent.invoke({
        team_id: team.id,
        slot_id: slot,
        input: message(`${knowledge}/features/${expert.id}.md`),
      });
      // The platform bridge returns provider errors as a sentinel object.
      const failure = ack as unknown as { __bridgeError?: boolean; message?: string };
      if (failure?.__bridgeError) throw new Error(failure.message ?? 'send failed');
    })
  );
  return experts.filter((_, index) => results[index].status === 'rejected').map((expert) => expert.name);
}
