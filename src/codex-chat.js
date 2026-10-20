import {spawn} from 'node:child_process';
import {existsSync, mkdirSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {now} from './time.js';

const sessionPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const instructions = 'Ты работаешь для владельца Price Checker в его личном Telegram-чате. Отвечай по-русски, понятно и кратко. Тебе разрешён полный доступ к серверу, включая root, файлы, логи и службы, в рамках задачи владельца. Прочитай AGENTS.md в рабочем Git-каталоге и следуй ему. Исходники меняй в /opt/price-checker/repository; текущий релиз находится в /opt/price-checker/current. После своих изменений обязательно используй $safe-commit-auto из .agents/skills/safe-commit-auto/SKILL.md: проверь изменения, сделай коммит и push до завершения работы. Stop-хук проверяет фактическую отправку. Не обходи хук, не коммить секреты или чужие изменения. Если push заблокирован, сообщи причину и не объявляй задачу завершённой. E2E и браузерные тесты запускать запрещено; unit-тесты с имитацией ответов разрешены. Не выдавай предположения за выполненные действия и проверяй текущее состояние перед ответом о сервере.';
const configuration = {
  sandbox_mode: 'danger-full-access', approval_policy: 'never', web_search: 'live',
  'features.shell_tool': true, 'features.apps': false, 'features.plugins': false,
  'features.hooks': true, 'features.multi_agent': false, 'features.browser_use': false,
  'features.computer_use': false, 'features.image_generation': false, 'features.view_image': false,
  developer_instructions: instructions
};

export class CodexError extends Error {
  constructor(reason) {super('Codex: ' + reason); this.reason = reason;}
}

function failureReason(message) {
  const text = String(message || '').toLowerCase();
  if (text.includes('git_delivery_not_verified')) return 'git_delivery';
  if (/usage limit|rate.?limit|quota|429|credits/.test(text)) return 'limit';
  if (/unauthori[sz]ed|401|sign.?in|log.?in|auth|token.*expired/.test(text)) return 'auth';
  return 'request';
}

export class CodexRunner {
  constructor({executable, workspace, timeoutMs = 2700000, spawnProcess = spawn}) {
    if (!isAbsolute(executable || '') || !isAbsolute(workspace || '')) throw new CodexError('configuration');
    if (!existsSync(workspace)) mkdirSync(workspace, {recursive: true, mode: 0o700});
    this.executable = executable; this.workspace = workspace; this.timeoutMs = timeoutMs;
    this.spawnProcess = spawnProcess; this.stoppers = new Set(); this.closed = false;
  }

  async turn({sessionId = null, prompt, onSession = () => {}, signal}) {
    if (this.closed || signal?.aborted) throw new CodexError('stopped');
    if ((sessionId && !sessionPattern.test(sessionId)) || typeof prompt !== 'string' || !prompt.trim()) throw new CodexError('configuration');
    const args = ['exec', '--cd', this.workspace, '--strict-config', '--dangerously-bypass-hook-trust', '--json'];
    for (const [key, value] of Object.entries(configuration)) args.push('-c', key + '=' + JSON.stringify(value));
    args.push(...(sessionId ? ['resume', sessionId, '-'] : ['-']));
    // The root launcher supplies its own credentials and reviewed hook configuration.
    const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP']
      .filter(key => process.env[key] != null).map(key => [key, process.env[key]]));
    return new Promise((resolve, reject) => {
      let child;
      try {child = this.spawnProcess(this.executable, args, {cwd: this.workspace, env, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']});}
      catch {reject(new CodexError('transport')); return;}
      let settled = false, buffer = '', bytes = 0, answer = '', thread = sessionId, completed = false, reason = null, forceTimer;
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(timer); clearTimeout(forceTimer);
        signal?.removeEventListener('abort', aborted); this.stoppers.delete(stop);
        if (error) reject(error); else resolve({sessionId: thread, text: answer});
      };
      const kill = name => {
        try {if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, name); else child.kill(name);}
        catch {try {child.kill(name);} catch {}}
      };
      const stop = why => {
        if (settled || reason) return;
        reason = why; kill('SIGTERM');
        forceTimer = setTimeout(() => {kill('SIGKILL'); finish(new CodexError(reason));}, 1500);
      };
      const aborted = () => stop('stopped');
      const timer = setTimeout(() => stop('timeout'), this.timeoutMs);
      this.stoppers.add(stop); signal?.addEventListener('abort', aborted, {once: true});
      const event = line => {
        if (!line.trim() || reason) return;
        let value;
        try {value = JSON.parse(line);} catch {stop('invalid_response'); return;}
        if (value.type === 'thread.started') {
          if (!sessionPattern.test(value.thread_id || '') || (sessionId && value.thread_id !== sessionId)) {stop('invalid_response'); return;}
          thread = value.thread_id;
          try {onSession(thread);} catch {stop('storage');}
        } else if (value.type === 'item.completed' && value.item?.type === 'agent_message') {
          if (typeof value.item.text !== 'string' || value.item.text.length > 64000) {stop('response_too_large'); return;}
          answer = value.item.text;
        } else if (value.type === 'turn.completed') completed = true;
        else if (value.type === 'turn.failed') stop(failureReason(value.error?.message));
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 8 * 1024 * 1024) {stop('response_too_large'); return;}
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {event(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);}
      });
      // CLI stderr can contain prompts, response bodies or authentication details.
      child.stderr.resume(); child.stdin.on('error', () => {});
      child.on('error', () => finish(new CodexError('transport')));
      child.on('close', code => {
        if (buffer) event(buffer);
        finish(reason ? new CodexError(reason) : code || !completed || !thread || !answer.trim() ? new CodexError('request') : null);
      });
      child.stdin.end(prompt);
      if (signal?.aborted) aborted();
    });
  }

  close() {this.closed = true; for (const stop of this.stoppers) stop('stopped');}
}

export function splitTelegramText(text, limit = 4000) {
  const parts = [];
  while (text.length > limit) {
    let end = text.lastIndexOf('\n', limit - 1);
    if (end < limit / 2) end = limit;
    else end++;
    if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    parts.push(text.slice(0, end)); text = text.slice(end);
  }
  if (text) parts.push(text);
  return parts;
}

const failureText = reason => ({
  git_delivery: 'Работа Codex не завершена: изменения не закоммичены или их отправка в Git не подтверждена. Подробности сохранены в серверном отчёте проверки Git.',
  auth: 'Codex требует повторного входа на сервере. Сообщение сохранено; после входа отправь его ещё раз.',
  limit: 'Достигнут лимит Codex. Сообщение сохранено; попробуй отправить его позже.',
  timeout: 'Codex не завершил работу за 45 минут. Сообщение сохранено; проверь состояние изменений перед продолжением.'
}[reason] || 'Не удалось получить ответ Codex. Сообщение сохранено; попробуй отправить его ещё раз.');

export class CodexChat {
  constructor(db, {runner, ownerId, send, logger = () => {}}) {
    this.db = db; this.runner = runner; this.ownerId = ownerId; this.send = send; this.logger = logger;
    this.activeKey = `telegram_dialogue:${ownerId}`; this.abort = new AbortController();
    db.run(`CREATE TABLE IF NOT EXISTS telegram_dialogues(
      id INTEGER PRIMARY KEY,owner_id INTEGER NOT NULL,created_at TEXT NOT NULL,session_id TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS telegram_ai_messages(
      update_id INTEGER NOT NULL,owner_id INTEGER NOT NULL,dialogue_id INTEGER NOT NULL REFERENCES telegram_dialogues(id),
      prompt TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',answer TEXT,created_at TEXT NOT NULL,finished_at TEXT,
      next_part INTEGER NOT NULL DEFAULT 0,delivered_at TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(update_id,owner_id))`);
    // An interrupted turn may already have reached OpenAI. Do not replay it automatically.
    db.run("UPDATE telegram_ai_messages SET status='failed',answer=?,finished_at=? WHERE owner_id=? AND status='running'",
      'Ответ Codex был прерван перезапуском. Сообщение сохранено; отправь его ещё раз для продолжения.', now(), ownerId);
  }

  log(event, error) {this.logger({time: now(), event, ...(error ? {reason: error instanceof CodexError ? error.reason : 'internal'} : {})});}
  pending() {return this.db.get('SELECT COUNT(*) AS n FROM telegram_ai_messages WHERE owner_id=? AND delivered_at IS NULL', this.ownerId).n;}
  newDialogue() {
    if (this.pending()) return false;
    this.db.setSetting(this.activeKey, null); return true;
  }

  enqueue(updateId, prompt) {
    if (this.db.get('SELECT 1 AS found FROM telegram_ai_messages WHERE update_id=? AND owner_id=?', updateId, this.ownerId)) return 'duplicate';
    if (this.pending() >= 10) return 'full';
    if (!prompt.trim() || prompt.length > 16000) return 'invalid';
    let dialogue = this.db.setting(this.activeKey);
    if (!dialogue) {
      dialogue = Number(this.db.run('INSERT INTO telegram_dialogues(owner_id,created_at) VALUES(?,?)', this.ownerId, now()).lastInsertRowid);
      this.db.setSetting(this.activeKey, dialogue);
    }
    this.db.run('INSERT INTO telegram_ai_messages(update_id,owner_id,dialogue_id,prompt,created_at) VALUES(?,?,?,?,?)',
      updateId, this.ownerId, dialogue, prompt, now());
    return 'queued';
  }

  processNext() {
    if (!this.processing) this.processing = (async () => {
      if (this.abort.signal.aborted) return;
      const row = this.db.get("SELECT m.*,d.session_id FROM telegram_ai_messages m JOIN telegram_dialogues d ON d.id=m.dialogue_id WHERE m.owner_id=? AND m.status='queued' ORDER BY m.update_id LIMIT 1", this.ownerId);
      if (!row) return;
      this.db.run("UPDATE telegram_ai_messages SET status='running' WHERE update_id=? AND owner_id=?", row.update_id, this.ownerId);
      try {
        const result = await this.runner.turn({sessionId: row.session_id, prompt: row.prompt, signal: this.abort.signal,
          onSession: sessionId => this.db.run('UPDATE telegram_dialogues SET session_id=? WHERE id=? AND owner_id=?', sessionId, row.dialogue_id, this.ownerId)});
        this.db.transaction(() => {
          this.db.run('UPDATE telegram_dialogues SET session_id=? WHERE id=? AND owner_id=?', result.sessionId, row.dialogue_id, this.ownerId);
          this.db.run("UPDATE telegram_ai_messages SET status='done',answer=?,finished_at=? WHERE update_id=? AND owner_id=?",
            result.text, now(), row.update_id, this.ownerId);
        });
        this.log('telegram_ai_completed');
      } catch (error) {
        if (this.abort.signal.aborted) return; // Constructor recovers this running row on restart.
        this.db.run("UPDATE telegram_ai_messages SET status='failed',answer=?,finished_at=? WHERE update_id=? AND owner_id=?",
          failureText(error instanceof CodexError ? error.reason : 'request'), now(), row.update_id, this.ownerId);
        this.log('telegram_ai_failed', error);
      }
    })().finally(() => {this.processing = null;});
    return this.processing;
  }

  deliverPending() {
    if (!this.delivering) this.delivering = (async () => {
      while (!this.abort.signal.aborted) {
        // Preserve message order, including a not-yet-finished or backed-off earlier reply.
        const row = this.db.get('SELECT * FROM telegram_ai_messages WHERE owner_id=? AND delivered_at IS NULL ORDER BY update_id LIMIT 1', this.ownerId);
        if (!row || !['done', 'failed'].includes(row.status) || row.next_attempt_ms > Date.now()) return;
        const parts = splitTelegramText(row.answer);
        try {
          for (let part = row.next_part; part < parts.length; part++) {
            if (this.abort.signal.aborted) return;
            await this.send(parts[part]);
            this.db.run('UPDATE telegram_ai_messages SET next_part=? WHERE update_id=? AND owner_id=?', part + 1, row.update_id, this.ownerId);
          }
          this.db.run('UPDATE telegram_ai_messages SET delivered_at=? WHERE update_id=? AND owner_id=?', now(), row.update_id, this.ownerId);
          this.log('telegram_ai_delivered');
        } catch (error) {
          if (!this.abort.signal.aborted) {
            const wait = Math.max(Math.min(60000, 2000 * 2 ** Math.min(row.attempts, 5)), (error.retryAfter || 0) * 1000);
            this.db.run('UPDATE telegram_ai_messages SET attempts=attempts+1,next_attempt_ms=? WHERE update_id=? AND owner_id=?', Date.now() + wait, row.update_id, this.ownerId);
            this.log('telegram_ai_delivery_failed');
          }
          return;
        }
      }
    })().finally(() => {this.delivering = null;});
    return this.delivering;
  }

  async close() {
    this.abort.abort(); this.runner.close();
    await Promise.allSettled([this.processing, this.delivering].filter(Boolean));
  }
}
