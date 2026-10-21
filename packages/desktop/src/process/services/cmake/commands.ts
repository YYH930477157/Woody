import type { CmakeConfiguration, CmakeTools } from '@/common/types/cmake';
import type { ResolvedVariants } from './variants';

export type CmakeCommand = { executable: string; args: string[] };

/** Configure from the build working directory, including support for CMake 3.5. */
export function configureCommand(
  projectPath: string,
  _config: CmakeConfiguration,
  variants: ResolvedVariants,
  tools: CmakeTools
): CmakeCommand {
  const definitions: Record<string, string | number | boolean> = {
    ...variants.settings,
    CMAKE_EXPORT_COMPILE_COMMANDS: true,
  };
  if (variants.buildType) definitions.CMAKE_BUILD_TYPE = variants.buildType;
  if (tools.cCompiler) definitions.CMAKE_C_COMPILER = tools.cCompiler.replaceAll('\\', '/');
  if (tools.cxxCompiler) definitions.CMAKE_CXX_COMPILER = tools.cxxCompiler.replaceAll('\\', '/');
  if (tools.make) definitions.CMAKE_MAKE_PROGRAM = tools.make.replaceAll('\\', '/');
  return {
    executable: tools.cmake,
    args: [
      '-G',
      'MinGW Makefiles',
      ...Object.entries(definitions).map(
        ([key, value]) => `-D${key}=${typeof value === 'boolean' ? (value ? 'ON' : 'OFF') : value}`
      ),
      projectPath,
    ],
  };
}

export function buildCommand(config: CmakeConfiguration, tools: CmakeTools): CmakeCommand {
  return {
    executable: tools.cmake,
    args: ['--build', '.', ...(config.target ? ['--target', config.target] : []), '--', `-j${config.jobs}`],
  };
}
