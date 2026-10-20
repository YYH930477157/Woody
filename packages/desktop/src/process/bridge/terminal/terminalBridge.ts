import { ipcBridge } from '@/common';
import { z } from 'zod';
import type { TerminalSendRequest } from '@/common/types/terminal';
import { getTerminalRuntime } from '@process/services/terminal/runtime';
import { listSerialPorts } from '@process/services/terminal/nativeTransport';
import { terminalSendSchema } from '@process/services/terminal/terminalRpc';
import { deliverTerminalGrant } from './terminalGrantDelivery';

const idSchema = z.object({ id: z.string().min(1).max(128) });

export function initTerminalBridge(): void {
  const api = ipcBridge.terminal;
  api.profiles.provider(async () => (await getTerminalRuntime()).profiles.list());
  api.saveProfile.provider(async (profile) => (await getTerminalRuntime()).profiles.upsert(profile));
  api.removeProfile.provider(async (input) => {
    const { id } = idSchema.parse(input);
    await (await getTerminalRuntime()).profiles.remove(id);
  });
  api.ports.provider(listSerialPorts);
  api.list.provider(async () => (await getTerminalRuntime()).service.list());
  api.open.provider(async (profile) => (await getTerminalRuntime()).service.open(profile));
  api.read.provider(async (input) => {
    const { id, cursor } = idSchema.extend({ cursor: z.number().int().nonnegative().optional() }).parse(input);
    return (await getTerminalRuntime()).service.read(id, cursor);
  });
  api.send.provider(async ({ id, request }) =>
    (await getTerminalRuntime()).service.send(
      idSchema.parse({ id }).id,
      terminalSendSchema.parse(request) as TerminalSendRequest
    )
  );
  api.cancel.provider(async (input) => {
    (await getTerminalRuntime()).service.cancel(idSchema.parse(input).id);
  });
  api.takeover.provider(async (input) => {
    (await getTerminalRuntime()).service.takeover(idSchema.parse(input).id);
  });
  api.interrupt.provider(async (input) => {
    await (await getTerminalRuntime()).service.interrupt(idSchema.parse(input).id);
  });
  api.close.provider(async (input) => {
    await (await getTerminalRuntime()).service.close(idSchema.parse(input).id);
  });
  api.setBaud.provider(async (input) => {
    const { id, baudRate } = idSchema.extend({ baudRate: z.number().int().positive().max(12_000_000) }).parse(input);
    return (await getTerminalRuntime()).service.setBaud(id, baudRate);
  });
  api.grant.provider(async (input) => {
    const { conversationId, connectionId, profileId, language } = z
      .object({
        conversationId: z.string().min(1).max(128),
        connectionId: z.string().min(1).max(128).optional(),
        profileId: z.string().min(1).max(128).optional(),
        language: z.string().max(32),
      })
      .parse(input);
    if (!!connectionId === !!profileId) throw new Error('terminal.invalidConnection');
    const { service, profiles } = await getTerminalRuntime();
    const profile = profileId ? (await profiles.list()).find((item) => item.id === profileId) : undefined;
    if (profileId && !profile) throw new Error('terminal.invalidProfile');
    const { ticket } = service.grant({ conversationId, connectionId, profile });
    try {
      await deliverTerminalGrant(conversationId, ticket, language);
    } catch (error) {
      service.revoke(ticket);
      throw error;
    }
  });
}
