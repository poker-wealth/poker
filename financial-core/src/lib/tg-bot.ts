import { loadEnv } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Telegram Bot client for ops alerts.
 * If TG_BOT_TOKEN + TG_OPS_CHAT_ID are configured, sends real messages via the
 * Bot API. Otherwise, logs at WARN level and records the would-be alert for
 * tests. Spec: CB6 (illegal fund flow) MUST alert ops within 5 seconds.
 */

export interface TgAlert {
  text: string;
  ts: number;
}

const recordedAlerts: TgAlert[] = [];

export async function sendTgAlert(text: string): Promise<void> {
  const ts = Date.now();
  recordedAlerts.push({ text, ts });

  const env = loadEnv();
  if (!env.TG_BOT_TOKEN || !env.TG_OPS_CHAT_ID) {
    logger.warn({ alert: text }, 'TG alert (no token configured — logged only)');
    return;
  }

  // Fire-and-forget HTTP POST. Spec says CB6 alerts must fire within 5s; we
  // don't await beyond the network roundtrip starting. If the network is slow,
  // the caller can choose whether to await or not.
  const url = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TG_OPS_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error({ status: res.status, body, alert: text }, 'TG sendMessage failed');
    }
  } catch (err) {
    logger.error({ err, alert: text }, 'TG sendMessage threw');
  }
}

/** Test helper — read the in-process alert log. Cleared by clearTgAlerts(). */
export function getRecordedTgAlerts(): readonly TgAlert[] {
  return recordedAlerts;
}

export function clearTgAlerts(): void {
  recordedAlerts.length = 0;
}
