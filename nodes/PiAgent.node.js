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
					type: 'options',
					typeOptions: { loadOptionsMethod: 'getPiModels' },
					default: '',
					description: 'pi 모델 (pi --list-models 자동 목록). 비우면 pi 기본 모델. 표현식 모드로 임의 provider/id도 가능',
				},
				{
					displayName: 'Thinking',
					name: 'thinking',
					type: 'options',
					default: '',
					description: '--thinking: 추론(사고) 레벨. 비우면 모델/pi 기본',
					options: [
						{ name: '(기본)', value: '' },
						{ name: 'off', value: 'off' },
						{ name: 'minimal', value: 'minimal' },
						{ name: 'low', value: 'low' },
						{ name: 'medium', value: 'medium' },
						{ name: 'high', value: 'high' },
						{ name: 'xhigh', value: 'xhigh' },
						{ name: 'max', value: 'max' },
					],
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
						{ displayName: '동시 실행 (아이템 병렬)', name: 'concurrency', type: 'number', default: 1, typeOptions: { minValue: 1, maxValue: 64 }, description: '여러 입력 아이템을 동시에 스폰해 처리 (1=순차). 각 아이템의 프롬프트 표현식은 개별 아이템 기준으로 평가된다' },
					],
				},
			],
		};
	}

	methods = {
		loadOptions: {
			// pi --list-models 파싱 → 모델 드롭다운 (값=provider/model, 컨텍스트·thinking 표기)
			async getPiModels() {
				const { execFile } = require('child_process');
				const os = require('os');
				const path = require('path');
				const run = (bin) => new Promise((resolve) => {
						execFile(bin, ['--list-models'], { timeout: 30000, env: { ...process.env, PATH: `${os.homedir()}/.npm-global/bin:${process.env.PATH || ''}` } }, (err, stdout) => resolve(err ? null : stdout));
					});
				let out = await run(path.join(os.homedir(), '.npm-global/bin/pi'));
				if (!out) out = await run('pi');
				if (!out) return [{ name: '(목록 로드 실패 — 표현식으로 직접 지정)', value: '' }];
				const rowRe = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(yes|no)\s+(yes|no)\s*$/;
				const options = [];
				for (const line of out.split('\n')) {
					const m = rowRe.exec(line.trim());
					if (!m) continue;
					const provider = m[1], model = m[2], ctx = m[3], thinking = m[5];
					if (provider === 'provider') continue;
						options.push({ name: `${provider}/${model}  (${ctx}, thinking:${thinking})`, value: `${provider}/${model}` });
				}
				return options.length ? options : [{ name: '(모델 없음)', value: '' }];
			},
		},
	};

	async execute() {
		const items = this.getInputData();
		const results = [];

		const concurrencyRaw = this.getNodeParameter('options', 0)?.concurrency;
		const concurrency = Math.max(1, Math.min(64, Number(concurrencyRaw) || 1));

		const runItem = async (i) => {
			const operation = this.getNodeParameter('operation', i);
			const prompt = this.getNodeParameter('prompt', i);
			const model = this.getNodeParameter('model', i) || '';
			const thinking = this.getNodeParameter('thinking', i) || '';
			const cwd = this.getNodeParameter('cwd', i) || '/tmp';
			const timeoutSec = Number(this.getNodeParameter('timeoutSec', i)) || DEFAULT_TIMEOUT;
			const options = this.getNodeParameter('options', i) || {};
			const abortSignal = typeof this.getExecutionCancelSignal === 'function' ? this.getExecutionCancelSignal() : undefined;

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
			if (thinking) args.push('--thinking', String(thinking));
			if (options.noTools) args.push('--no-tools');
			if (options.extraArgs) args.push(...String(options.extraArgs).split(/\s+/).filter(Boolean));
			args.push('--', String(prompt));

			const out = await runPi(args, cwd, timeoutSec * 1000, operation, sessionId, abortSignal);
			return { json: out };
		};

		if (concurrency > 1 && items.length > 1) {
			// 바운디드 풀: 동시 스폰, 결과는 입력 순서 유지
			const outs = new Array(items.length);
			let next = 0;
			const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
				while (true) {
					const i = next++;
					if (i >= items.length) break;
					outs[i] = await runItem(i);
				}
			});
			await Promise.all(workers);
			return [outs];
		}

		for (let i = 0; i < items.length; i++) {
			results.push(await runItem(i));
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
// 프로세스 트리 전체 강제 종료 — pi는 bash 도구 자식을 별도 pgid로 띄우므로
// ① /proc 자손 트리를 재귀 수집해 리프부터 킬 ② pi 본체·그룹 킬. (고아·좀비 방지)
function killTree(child) {
	if (!child || !child.pid || child.killed === true) { /* killed 플래그와 무관하게 pid 있으면 시도 */ }
	if (!child || !child.pid) return;
	const fs = require('fs');
	const collected = [];
	const walk = (pid) => {
		let kids = [];
		try {
			kids = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
		} catch { return; }
		for (const k of kids) { collected.push(k); walk(k); }
	};
	try { walk(child.pid); } catch { /* 무시 */ }
	for (const pid of collected.reverse()) {
		try { process.kill(-pid, 'SIGKILL'); } catch { /* 그룹 없음 */ }
		try { process.kill(pid, 'SIGKILL'); } catch { /* 이미 죽음 */ }
	}
	try { child.kill('SIGKILL'); } catch { /* 이미 죽음 */ }
	try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 그룹 없음 */ }
}

function runPi(args, cwd, timeoutMs, operation, sessionId, abortSignal) {
	return new Promise((resolve) => {
		if (abortSignal && abortSignal.aborted) {
			resolve({ ok: false, mode: operation, sessionId, killed: true, exitCode: null, model: undefined, text: undefined, usage: undefined, cost: undefined, durationMs: undefined, stderrTail: 'canceled: 실행 시작 전 취소' });
			return;
		}

		// 디버그 트레이스: 원시 stdout/stderr 항상 파일로 (문제 진단용, 성공 시 자동 삭제)
		const dbgDir = '/tmp/pi-debug';
		try { require('fs').mkdirSync(dbgDir, { recursive: true }); } catch { /* 무시 */ }
		const dbg = `${dbgDir}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.log`;
		const dbgFd = (() => { try { return require('fs').openSync(dbg, 'a'); } catch { return null; } })();

		const bin = resolvePiBin();
		// detached=자체 프로세스 그룹 — killTree로 그룹 전체 종료 가능. 취소 신호 연결.
		const child = spawn(bin, args, { cwd, env: { ...process.env, PATH: `${os.homedir()}/.npm-global/bin:${process.env.PATH || ''}` }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
		const onAbort = () => {
			if (settled) return;
			killed = true;
			killTree(child);
			finish({ ok: false, mode: operation, sessionId, killed: true, exitCode: null, model: undefined, text: undefined, usage: undefined, cost: undefined, durationMs: undefined, stderrTail: 'canceled: 실행 취소로 pi 프로세스 그룹 종료' });
		};
		if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true });
		let stdout = '';
		let stderr = '';
		let killed = false;
		let settled = false;

		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(stallTimer);
			if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
			if (dbgFd !== null) {
				try { require('fs').closeSync(dbgFd); } catch { /* 무시 */ }
				// 성공(텍스트 있음)이면 디버그 파일 삭제, 실패면 남김
				if (result && result.text) { try { require('fs').unlinkSync(dbg); } catch { /* 무시 */ } }
			} else { try { require('fs').unlinkSync(dbg); } catch { /* 무시 */ } }
			resolve(result);
		};

		const timer = setTimeout(() => {
			killed = true;
			try { child.kill('SIGTERM'); } catch { /* 무시 */ }
			try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { /* 무시 */ }
			setTimeout(() => killTree(child), 5000);
		}, timeoutMs);

		// 스톨 와치독: stdout이 300초(5분)간 침묵하면(스트림 행업) 강제 종료 — 풀 봉쇄 방지.
		// 5분인 이유: 정상적인 긴 도구 실행(vast 프로브 ~4분) 중에도 stdout이 조용할 수 있음.
		const STALL_MS = 300000;
		let stallTimer = null;
		const armStall = () => {
			clearTimeout(stallTimer);
			stallTimer = setTimeout(() => {
				if (settled) return;
				killed = true;
				killTree(child);
				finish({ ok: false, mode: operation, sessionId, killed: true, exitCode: null, model: undefined, text: undefined, usage: undefined, cost: undefined, durationMs: undefined, stderrTail: 'stall-watchdog: 300초간 출력 없음 — 스트림 행업으로 강제 종료' });
			}, STALL_MS);
		};
		armStall();

		// 스폰 실패(ENOENT 등) 포함 — 절대 대기하지 않는다
		child.on('error', (err) => {
			finish({ ok: false, mode: operation, sessionId, killed, exitCode: null, model: undefined, text: undefined, usage: undefined, cost: undefined, durationMs: undefined, stderrTail: `pi spawn 실패 (${bin}): ${err.message}` });
		});

		child.stdout.on('data', (d) => {
			stdout += d.toString();
			armStall();
			if (dbgFd !== null) { try { require('fs').appendFileSync(dbgFd, `[OUT] ${d}`); } catch { /* 무시 */ } }
		});
		child.stderr.on('data', (d) => {
			stderr += d.toString();
			if (dbgFd !== null) { try { require('fs').appendFileSync(dbgFd, `[ERR] ${d}`); } catch { /* 무시 */ } }
		});

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
