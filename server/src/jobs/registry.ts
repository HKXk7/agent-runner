import type { JobDefinition } from '@agent-runner/shared';
import { demoPipeline } from './demo-pipeline.js';
import { schoolNotice } from './school-notice.js';

const defs = new Map<string, JobDefinition>();

/** 注册任务定义（冒烟测试可注册 flaky job 验证重试机制） */
export function register(def: JobDefinition): void {
  defs.set(def.type, def);
}

register(demoPipeline);
register(schoolNotice);

export function getDefinition(type: string): JobDefinition | undefined {
  return defs.get(type);
}

export function listDefinitions(): JobDefinition[] {
  return [...defs.values()];
}
