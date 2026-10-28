'use strict';

/**
 * Pi Agent — pi 코딩 에이전트를 헤드리스(pi -p --mode json)로 발사하는 노드.
 *
 * 동작 모드:
 *  - oneshot : 세션 없이 일회성 발사 (--no-session) — 남는 것 없음
 *  - new     : 새 세션 발사 — uuid를 생성해 --session-id로 지정하므로 id를 결정적으로 알 수 있음 (+ --name)
 *  - continue: 기존 세션 재개 (--session-id)
 *
 * 출력: { ok, mode, sessionId?, model, text, usage, cost, durationMs, exitCode, stderrTail? }
 * 참고: 이 머신의 pi CLI (~/.npm-global/bin/pi). n8n 프로세스 사용자의 pi 자격증명 그대로 사용.
 * 주의: n8n execute 컨텍스트의 this는 노드 인스턴스가 아니므로 헬퍼는 모듈 레벨 함수여야 함.
 */

const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const os = require('os');

const DEFAULT_TIMEOUT = 600; // 초

class PiAgent {
	constructor() {
		this.description = {
			displayName: 'Pi Agent',
			name: 'piAgent',
			icon: 'file:pi.svg',
			group: ['transform'],
			version: 1,
			subtitle: '={{$parameter["operation"]}}',
			description: 'pi 코딩 에이전트 헤드리스 발사 (일회성 / 새 세션 / 세션 재개)',
			defaults: { name: 'Pi Agent' },
			inputs: ['main'],
			outputs: ['main'],
			properties: [
				{
					displayName: 'Mode',
					name: 'operation',
					type: 'options',
					noExpression: true,
					options: [
						{ name: 'One-shot (세션 없음)', value: 'oneshot', description: '일회성 발사 — 세션 저장 안 함 (--no-session)' },
						{ name: 'New Session (새 세션)', value: 'new', description: '새 세션 생성·저장 — sessionId 반환, --name 지정 가능' },
						{ name: 'Continue Session (재개)', value: 'continue', description: '기존 세션 id로 이어서 발사' },
					],
					default: 'oneshot',
				},
				{
					displayName: 'Prompt',
					name: 'prompt',
					type: 'string',
					typeOptions: { rows: 6 },
					required: true,
					default: '',
					description: 'pi에게 줄 프롬프트 (LLM 턴 1회)',
				},
				{
					displayName: 'Session ID',
					name: 'sessionId',
					type: 'string',
					displayOptions: { show: { operation: ['continue'] } },
					required: true,
					default: '',
					description: '재개할 pi 세션 id (New Session 결과의 sessionId)',
				},
				{
					displayName: 'Session Name',
					name: 'sessionName',
					type: 'string',
					displayOptions: { show: { operation: ['new'] } },
					default: '',
					placeholder: 'n8n-worker',
					description: '새 세션 표시명 (--name, 세션 목록에서 식별용)',
				},
				{
					displayName: 'Model',
					name: 'model',
					type: 'string',
					default: '',
					placeholder: 'glm-5.3 / anthropic/claude-… / provider/id',
					description: '모델 패턴 또는 provider/id (비우면 pi 기본 모델)',
				},
				{
					displayName: 'Working Directory',
					name: 'cwd',
					type: 'string',
					default: '/tmp',
					description: 'pi가 작업할 디렉터리 (코딩 에이전트의 프로젝트 루트)',
				},
				{
					displayName: 'Timeout (초)',
					name: 'timeoutSec',
					type: 'number',
					default: DEFAULT_TIMEOUT,
					description: '이 시간 내에 끝나지 않으면 프로세스 종료 후 오류',
				},
				{
					displayName: 'Options',
					name: 'options',
					type: 'collection',
					placeholder: '옵션 추가',
					default: {},
					options: [
						{ displayName: 'Extra CLI Args', name: 'extraArgs', type: 'string', default: '', placeholder: '--no-tools 등 (공백 구분)', description: 'pi CLI에 전달할 추가 인자' },
						{ displayName: 'Disable Tools', name: 'noTools', type: 'boolean', default: false, description: '--no-tools: 도구 없이 텍스트만 (LLM 답변만 필요할 때)' },
					],
				},
			],
		};
	}

	async execute() {
		const items = this.getInputData();
		const results = [];

		for (let i = 0; i < items.length; i++) {
			const operation = this.getNodeParameter('operation', i);
			const prompt = this.getNodeParameter('prompt', i);
			const model = this.getNodeParameter('model', i) || '';
			const cwd = this.getNodeParameter('cwd', i) || '/tmp';
			const timeoutSec = Number(this.getNodeParameter('timeoutSec', i)) || DEFAULT_TIMEOUT;
			const options = this.getNodeParameter('options', i) || {};

			const args = ['-p', '--mode', 'json'];
			let sessionId = null;

			if (operation === 'oneshot') {
				args.push('--no-session');
			} else if (operation === 'new') {
				sessionId = randomUUID();
				args.push('--session-id', sessionId);
				const name = this.getNodeParameter('sessionName', i);
				if (name) args.push('--name', String(name));
			} else {
				sessionId = String(this.getNodeParameter('sessionId', i)).trim();
				args.push('--session-id', sessionId);
			}

			if (model) args.push('--model', String(model));
			if (options.noTools) args.push('--no-tools');
			if (options.extraArgs) args.push(...String(options.extraArgs).split(/\s+/).filter(Boolean));
			args.push('--', String(prompt));

			const out = await runPi(args, cwd, timeoutSec * 1000, operation, sessionId);
			results.push({ json: out });
		}

		return [results];
	}
}

// pi 바이너리 경로 리졸브: PI_BIN env > PATH(pi) > npm-global > npx 캐시 glob — 캐시됨
let _piBin = null;
function resolvePiBin() {
	if (_piBin) return _piBin;
	const fs = require('fs');
	const path = require('path');
	const home = os.homedir();
	const candidates = [];
	if (process.env.PI_BIN) candidates.push(process.env.PI_BIN);
	candidates.push(path.join(home, '.npm-global', 'bin', 'pi'));
	// npx 캐시: ~/.npm/_npx/<hash>/node_modules/.bin/pi
	try {
		const npxDir = path.join(home, '.npm', '_npx');
		for (const h of fs.readdirSync(npxDir)) {
			candidates.push(path.join(npxDir, h, 'node_modules', '.bin', 'pi'));
		}
	} catch { /* 없음 */ }
	for (const c of candidates) {
		try { if (fs.existsSync(c) && fs.accessSync(c, fs.constants.X_OK) === undefined) { _piBin = c; return c; } } catch { /* 다음 */ }
	}
	_piBin = 'pi'; // 마지막 수단: PATH에 걸어봄
	return _piBin;
}

// pi 스폰 실행 (모듈 레벨 — this 컨텍스트와 무관하게)
function runPi(args, cwd, timeoutMs, operation, sessionId) {
	return new Promise((resolve) => {
		const env = { ...process.env };
		env.PATH = `${os.homedir()}/.npm-global/bin:${env.PATH || ''}`;

		const bin = resolvePiBin();
		const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		let killed = false;
		let settled = false;

		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};

		const timer = setTimeout(() => {
			killed = true;
			child.kill('SIGTERM');
			setTimeout(() => child.kill('SIGKILL'), 5000);
		}, timeoutMs);

		// 스폰 실패(ENOENT 등) 포함 — 절대 대기하지 않는다
		child.on('error', (err) => {
			finish({ ok: false, mode: operation, sessionId, killed, exitCode: null, model: undefined, text: undefined, usage: undefined, cost: undefined, durationMs: undefined, stderrTail: `pi spawn 실패 (${bin}): ${err.message}` });
		});

		child.stdout.on('data', (d) => { stdout += d.toString(); });
		child.stderr.on('data', (d) => { stderr += d.toString(); });

		child.on('close', (code) => {
			const parsed = parsePiOutput(stdout);
			finish({
				ok: !killed && code === 0 && !!parsed.text,
				mode: operation,
				sessionId,
				killed,
				exitCode: code,
				model: parsed.model,
				text: parsed.text,
				usage: parsed.usage,
				cost: parsed.cost,
				durationMs: parsed.durationMs,
				stderrTail: stderr ? stderr.slice(-500) : undefined,
			});
		});
	});
}

// pi --mode json NDJSON 스트림 파싱: agent_end.messages 에서 마지막 assistant 메시지 추출
function parsePiOutput(stdout) {
	const out = { model: undefined, text: undefined, usage: undefined, cost: undefined, durationMs: undefined };
	let agentEnd = null;
	for (const line of stdout.split('\n')) {
		const t = line.trim();
		if (!t.startsWith('{')) continue;
		try {
			const ev = JSON.parse(t);
			if (ev.type === 'agent_end') agentEnd = ev;
		} catch { /* 부분 라인 무시 */ }
	}
	if (agentEnd) {
		const msgs = agentEnd.messages || [];
		for (let i = msgs.length - 1; i >= 0; i--) {
			const m = msgs[i];
			if (m.role === 'assistant' && Array.isArray(m.content)) {
				out.text = m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
				out.model = m.model;
				out.usage = m.usage;
				out.cost = m.usage && m.usage.cost ? m.usage.cost.total : undefined;
				out.durationMs = m.durationMs;
				break;
			}
		}
	}
	return out;
}

module.exports = { PiAgent };
