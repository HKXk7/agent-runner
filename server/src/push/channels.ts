/**
 * 推送渠道抽象（零外部依赖，Node 原生 fetch）。
 *
 * 设计：日报生成后，除了写收件箱（DB + 本地 markdown），可选推到微信/邮件。
 *   - ServerChan（Server酱）: 微信推送，国内到达率最好 —— 需注册拿 sendkey
 *   - PushPlus             : 微信推送，另一家 —— 需注册拿 token
 *   - File                 : 本地文件归档（永远可用，作为降级兜底）
 * 路由规则：按 env 配置启用所有已配置的渠道；一个都没配置则回退 File。
 * 任何渠道发送失败只写 push_failed 审计，绝不拖垮 job（降级不降可用性）。
 */

export interface PushMessage {
  title: string;
  body: string; // markdown 或纯文本
}

export interface PushChannel {
  readonly name: string;
  enabled(): boolean;
  send(msg: PushMessage): Promise<void>;
}

/** 本地文件归档渠道：零配置兜底。body 已由收件箱 markdown 归档，这里仅打审计标记。 */
export class FileChannel implements PushChannel {
  readonly name = 'file';
  enabled(): boolean {
    return true;
  }
  async send(_msg: PushMessage): Promise<void> {
    // 文件归档在 writeDigest 内完成，这里无额外副作用
  }
}

/** Server酱（sctapi）：微信推送。env: SERVERCHAN_SENDKEY */
export class ServerChanChannel implements PushChannel {
  readonly name = 'serverchan';
  enabled(): boolean {
    return !!process.env.SERVERCHAN_SENDKEY;
  }
  async send(msg: PushMessage): Promise<void> {
    const key = process.env.SERVERCHAN_SENDKEY!;
    const res = await fetch(`https://sctapi.ftqq.com/${key}.send`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ title: msg.title, desp: msg.body }).toString(),
    });
    if (!res.ok) throw new Error(`serverchan HTTP ${res.status}`);
    const data = (await res.json()) as { code?: number; message?: string };
    if (data.code !== 0) throw new Error(`serverchan ${data.message ?? data.code}`);
  }
}

/** PushPlus：微信推送。env: PUSHPLUS_TOKEN */
export class PushPlusChannel implements PushChannel {
  readonly name = 'pushplus';
  enabled(): boolean {
    return !!process.env.PUSHPLUS_TOKEN;
  }
  async send(msg: PushMessage): Promise<void> {
    const res = await fetch('https://www.pushplus.plus/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: process.env.PUSHPLUS_TOKEN!,
        title: msg.title,
        content: msg.body,
        template: 'markdown',
      }),
    });
    if (!res.ok) throw new Error(`pushplus HTTP ${res.status}`);
    const data = (await res.json()) as { code?: number; msg?: string };
    if (data.code !== 200) throw new Error(`pushplus ${data.msg ?? data.code}`);
  }
}

/** 返回所有已启用的渠道；无外部配置时回退 File（本地归档）。 */
export function getPushChannels(): PushChannel[] {
  const channels: PushChannel[] = [new ServerChanChannel(), new PushPlusChannel()].filter((c) =>
    c.enabled(),
  );
  if (channels.length === 0) return [new FileChannel()];
  return channels;
}
