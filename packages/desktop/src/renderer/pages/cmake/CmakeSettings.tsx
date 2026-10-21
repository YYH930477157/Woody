import React from 'react';
import { Checkbox, Form, Input, InputNumber } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { CmakeConfiguration, CmakeTools } from '@/common/types/cmake';
import styles from './CmakePanel.module.css';

export default function CmakeSettings({
  value,
  onChange,
  disabled,
}: {
  value: CmakeConfiguration;
  onChange: (config: CmakeConfiguration) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const tools: Array<[keyof CmakeTools, 'cmakePath' | 'ctestPath' | 'cCompilerPath' | 'cxxCompilerPath' | 'makePath']> =
    [
      ['cmake', 'cmakePath'],
      ['ctest', 'ctestPath'],
      ['cCompiler', 'cCompilerPath'],
      ['cxxCompiler', 'cxxCompilerPath'],
      ['make', 'makePath'],
    ];
  return (
    <Form layout='vertical' className={styles.settings} disabled={disabled}>
      {tools.map(([key, label]) => (
        <Form.Item key={key} label={t(`tools.cmake.${label}`)}>
          <Input
            aria-label={t(`tools.cmake.${label}`)}
            placeholder={t('tools.cmake.autoDetect')}
            value={value.tools[key]}
            onChange={(text) => onChange({ ...value, tools: { ...value.tools, [key]: text } })}
          />
        </Form.Item>
      ))}
      <Form.Item label={t('tools.cmake.target')}>
        <Input
          aria-label={t('tools.cmake.target')}
          value={value.target}
          onChange={(target) => onChange({ ...value, target })}
        />
      </Form.Item>
      <Form.Item label={t('tools.cmake.jobs')}>
        <InputNumber
          aria-label={t('tools.cmake.jobs')}
          min={1}
          max={32}
          precision={0}
          value={value.jobs}
          onChange={(jobs) => onChange({ ...value, jobs: jobs || 1 })}
        />
      </Form.Item>
      <Form.Item label={t('tools.cmake.timeoutMinutes')}>
        <InputNumber
          aria-label={t('tools.cmake.timeoutMinutes')}
          min={1}
          max={1440}
          precision={0}
          value={value.timeoutMs / 60000}
          onChange={(minutes) => onChange({ ...value, timeoutMs: (minutes || 1) * 60000 })}
        />
      </Form.Item>
      <Form.Item label={t('tools.cmake.runExecutable')}>
        <Input
          aria-label={t('tools.cmake.runExecutable')}
          value={value.runExecutable}
          onChange={(runExecutable) => onChange({ ...value, runExecutable })}
        />
      </Form.Item>
      <Form.Item label={t('tools.cmake.runArguments')}>
        <Input.TextArea
          aria-label={t('tools.cmake.runArguments')}
          value={value.runArguments.join('\n')}
          onChange={(text) => onChange({ ...value, runArguments: text ? text.split('\n') : [] })}
        />
      </Form.Item>
      <Checkbox checked={value.require32Bit} onChange={(require32Bit) => onChange({ ...value, require32Bit })}>
        {t('tools.cmake.require32Bit')}
      </Checkbox>
    </Form>
  );
}
