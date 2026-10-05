import { EventEmitter } from 'node:events';
import type { SSEEvent } from '@agent-runner/shared';

/**
 * 进程内事件总线：worker/调度器产生领域事件 -> SSE 连接消费。
 * job 事件按 jobId 定向投递；全局通道（'*'）供看板订阅所有事件。
 */
class Bus extends EventEmitter {
  private global = new EventEmitter();

  constructor() {
    super();
    this.global.setMaxListeners(200);
    this.setMaxListeners(200);
  }

  publish(jobId: string, ev: SSEEvent): void {
    // 定向
    if (jobId !== '*') this.emit(jobId, ev);
    // 全局
    this.global.emit('event', { jobId, ev });
  }

  subscribe(jobId: string, cb: (ev: SSEEvent) => void): () => void {
    this.on(jobId, cb);
    return () => this.off(jobId, cb);
  }

  subscribeAll(cb: (jobId: string, ev: SSEEvent) => void): () => void {
    const h = ({ jobId, ev }: { jobId: string; ev: SSEEvent }) => cb(jobId, ev);
    this.global.on('event', h);
    return () => this.global.off('event', h);
  }
}

export const bus = new Bus();
