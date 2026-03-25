import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const dataDir = s => path.resolve(__dirname, '..', 'data', s);
export const resolve = (...a) => a.length && a[0] == '0' ? null : path.resolve(...a);

import { JSONFilePreset } from 'lowdb/node';
export const jsonDb = (file, defaultData) => JSONFilePreset(dataDir(file), defaultData);

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const datetimeUTC = (d = new Date()) => d.toISOString().replace('T', ' ').replace('Z', '');
export const datetime = (d = new Date()) => datetimeUTC(new Date(d.getTime() - d.getTimezoneOffset() * 60000));
export const filenamify = s => s.replaceAll(':', '.').replace(/[^a-z0-9 _\-.]/gi, '_');

import Enquirer from 'enquirer';
import { cfg } from './config.js';

const enquirer = new Enquirer();
const timeoutPlugin = timeout => enquirer => {
  enquirer.on('prompt', prompt => {
    const t = setTimeout(() => {
      prompt.hint = () => 'timeout';
      prompt.cancel();
    }, timeout);
    prompt.on('submit', _ => clearTimeout(t));
    prompt.on('cancel', _ => clearTimeout(t));
  });
};
enquirer.use(timeoutPlugin(cfg.login_timeout));

export const prompt = o => enquirer.prompt({ name: 'name', type: 'input', message: 'Enter value', ...o }).then(r => r.name).catch(_ => {});
export const confirm = o => prompt({ type: 'confirm', message: 'Continue?', ...o });

import { execFile } from 'child_process';

const sendNotification = html => new Promise((resolve, reject) => {
  const args = [cfg.notify, '-i', 'html', '-b', `'${html}'`];
  if (cfg.notify_title) args.push(...['-t', cfg.notify_title]);
  if (cfg.debug) console.debug(`apprise ${args.map(a => `'${a}'`).join(' ')}`);
  execFile('apprise', args, (error, stdout, stderr) => {
    if (error) {
      console.log(`error: ${error.message}`);
      if (error.message.includes('command not found')) {
        console.info('Run `pip install apprise`. See https://github.com/vogler/free-games-claimer#notifications');
      }
      return reject(error);
    }
    if (stderr) console.error(`stderr: ${stderr}`);
    if (stdout) console.log(`stdout: ${stdout}`);
    resolve();
  });
});

const MAX_MSG_LEN = 900;

export const notify = async html => {
  if (!cfg.notify) {
    if (cfg.debug) console.debug('notify: NOTIFY is not set!');
    return;
  }
  if (html.length <= MAX_MSG_LEN) {
    return sendNotification(html);
  }
  const lines = html.split('<br>');
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if (line.length > MAX_MSG_LEN) {
      if (current) { chunks.push(current); current = ''; }
      for (let j = 0; j < line.length; j += MAX_MSG_LEN) {
        chunks.push(line.slice(j, j + MAX_MSG_LEN));
      }
      continue;
    }
    const candidate = current ? current + '<br>' + line : line;
    if (candidate.length > MAX_MSG_LEN && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  for (let i = 0; i < chunks.length; i++) {
    const part = chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : '';
    await sendNotification(chunks[i] + part);
  }
};

export const escapeHtml = unsafe => unsafe.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\'', '&#039;');

export const html_game_list = games => games.map(g => `- <a href="${g.url}">${escapeHtml(g.title)}</a> (${g.status})`).join('<br>');
