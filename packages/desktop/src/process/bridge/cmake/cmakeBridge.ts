import { cmake } from '@/common/adapter/cmake';
import { z } from 'zod';
import { shell } from 'electron';
import { getCmakeRuntime } from '@process/services/cmake/runtime';
import { jobSchema, projectSchema, startSchema } from './validation';
import { gdbRequestSchema } from '@process/services/cmake/gdb/validation';

/** Main-process validation and error transport are shared by every panel instance. */
export function initCmakeBridge(): void {
  cmake.discover.provider(async (input) => {
    const { projectPath, selection } = projectSchema
      .extend({ selection: z.string().min(1).max(32768).optional() })
      .strict()
      .parse(input);
    return (await getCmakeRuntime()).service.discover(projectPath, selection);
  });
  cmake.debug.provider(async (input) => (await getCmakeRuntime()).debug.request(gdbRequestSchema.parse(input)));
  cmake.debugAiEnabled.provider(async (input) =>
    (await getCmakeRuntime()).rpc.isDebugEnabled(projectSchema.parse(input).projectPath)
  );
  cmake.setDebugAiEnabled.provider(async (input) => {
    const { projectPath, enabled } = projectSchema.extend({ enabled: z.boolean() }).parse(input);
    await (await getCmakeRuntime()).rpc.setDebugEnabled(projectPath, enabled);
  });
  cmake.inspect.provider(async (input) => {
    const { projectPath, discover } = projectSchema.extend({ discover: z.boolean().optional() }).parse(input);
    return (await getCmakeRuntime()).service.inspect(projectPath, discover === true);
  });
  cmake.reload.provider(async (input) =>
    (await getCmakeRuntime()).service.reload(projectSchema.strict().parse(input).projectPath)
  );
  cmake.revealConfiguration.provider(async (input) => {
    const file = await (
      await getCmakeRuntime()
    ).service.configurationPath(projectSchema.strict().parse(input).projectPath);
    shell.showItemInFolder(file);
  });
  cmake.save.provider(async (input) => {
    const { projectPath } = projectSchema.parse(input);
    return (await getCmakeRuntime()).service.save(projectPath, input.config);
  });
  cmake.start.provider(async (input) => {
    const { projectPath, action, selection } = startSchema.parse(input);
    return (await getCmakeRuntime()).service.start(projectPath, action, selection);
  });
  cmake.read.provider(async (input) => {
    const { jobId, cursor } = jobSchema.extend({ cursor: z.number().int().nonnegative().optional() }).parse(input);
    return (await getCmakeRuntime()).service.read(jobId, cursor);
  });
  cmake.cancel.provider(async (input) => (await getCmakeRuntime()).service.cancel(jobSchema.parse(input).jobId));
  cmake.aiEnabled.provider(async (input) =>
    (await getCmakeRuntime()).rpc.isEnabled(projectSchema.parse(input).projectPath)
  );
  cmake.setAiEnabled.provider(async (input) => {
    const { projectPath, enabled } = projectSchema.extend({ enabled: z.boolean() }).parse(input);
    await (await getCmakeRuntime()).rpc.setEnabled(projectPath, enabled);
  });
}
