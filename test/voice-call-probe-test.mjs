/**
 * 语音通话 Phase 0（音频探针骨架）的密闭测试 —— 全程假进程，不碰真音频设备。
 *
 * 覆盖（对齐评审提示词的验收点）：
 *   1. 设备枚举解析：dshow stderr（中文名/过滤 video）、waveOut 列表、PnP 端点 JSON
 *   2. PCM/WAV 工具：RMS 电平、测试音 WAV 头与长度、PCM→WAV 往返
 *   3. Receiver 正常流：PCM → level 事件 → 主动 stop（exit 无错误原因）
 *   4. 设备掉线：非人为退出 → 'error' 带原因（stderr 尾巴），绝不静默
 *   5. 无数据兜底：窗口内零 PCM → 'error'（先报错再停，不被 stop 吞掉）
 *   6. playWavToDevice：参数契约（-Action play / -WavPath / -DeviceId）+ 成功/失败路径
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const devicesMod = await import('../src/voice-call/audio-devices.js');
const bridgeMod = await import('../src/voice-call/bridge.js');
const { parseDshowDevices, parseWaveOutList, parseEndpointStatus, parseRenderEndpoints } = devicesMod;
const { Receiver, S16Resampler, makeToneWav, pcmToWav, pcmRms, playWavToDevice } = bridgeMod;

let bad = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  [ok] ${label}`); }
  catch (e) { bad++; console.log(`  [FAIL] ${label} -- ${e.message}`); }
};
const checkAsync = async (label, fn) => {
  try { await fn(); console.log(`  [ok] ${label}`); }
  catch (e) { bad++; console.log(`  [FAIL] ${label} -- ${e.message}`); }
};

console.log('\n== 设备枚举解析 ==');

check('dshow stderr：中文名录音设备全数解析，video 行不混入（dshow 只列 capture）', () => {
  const sample = [
    '[in#0 @ 000001f77bee88c0] "麦克风 (4- HECATE G30 S )" (audio)',
    '[in#0 @ 000001f77bee88c0] "麦克风 (NICEHCK HiFi Audio)" (audio)',
    '[in#2 @ 000001f77bee9c40] "USB Video Device" (video)'
  ].join('\n');
  const list = parseDshowDevices(sample);
  assert.equal(list.length, 2);
  assert.ok(list.some((d) => d.name === '麦克风 (4- HECATE G30 S )'));
  assert.ok(list.some((d) => d.name === '麦克风 (NICEHCK HiFi Audio)'));
  assert.ok(!list.some((d) => /USB Video/.test(d.name)), 'video 设备不得混入');
});

check('waveOut 列表：index|name 行解析', () => {
  const list = parseWaveOutList('0|扬声器 (Realtek(R) Audio)\n1|CABLE Input (VB-Audio Virtual Cable)\n\n');
  assert.equal(list.length, 2);
  assert.equal(list[0].index, 0);
  assert.equal(list[1].name, 'CABLE Input (VB-Audio Virtual Cable)');
});

check('PnP 端点 JSON：数组/单对象/坏数据三种形态', () => {
  const arr = parseEndpointStatus('[{"Status":"OK","FriendlyName":"麦克风"},{"Status":"Error","FriendlyName":"扬声器"}]');
  assert.equal(arr.length, 2);
  assert.equal(arr[1].status, 'Error');
  const single = parseEndpointStatus('{"Status":"OK","FriendlyName":"只有一个"}');
  assert.equal(single.length, 1);
  assert.equal(parseEndpointStatus('not json').length, 0);
});

check('播放端点列表：逐行名解析 + 空行忽略', () => {
  const list = parseRenderEndpoints('扬声器 (Realtek High Definition Audio)\n耳机 (4- HECATE G30 S )\n\n');
  assert.equal(list.length, 2);
  assert.equal(list[0].name, '扬声器 (Realtek High Definition Audio)');
  assert.equal(parseRenderEndpoints('  \n\n').length, 0);
});

console.log('\n== PCM / WAV 工具 ==');

check('RMS：响亮信号与静音的 dB 差距 > 40dB', () => {
  const loud = Buffer.alloc(1600);
  for (let i = 0; i < 800; i++) loud.writeInt16LE(Math.round(12000 * Math.sin(i / 3)), i * 2);
  const quiet = Buffer.alloc(1600);   // 全零
  const a = pcmRms(loud);
  const b = pcmRms(quiet);
  assert.ok(a.db > -20, `响亮应 > -20dB，实际 ${a.db}`);
  assert.equal(b.db, -120);
  assert.ok(a.db - b.db > 40);
});

check('makeToneWav：头部正确（RIFF/WAVE/PCM/24000Hz）+ 长度匹配 + 有淡入淡出', () => {
  const wav = makeToneWav({ seconds: 2, freq: 440, rate: 24000, amp: 0.3 });
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(20), 1);          // PCM
  assert.equal(wav.readUInt16LE(22), 1);          // mono
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt16LE(34), 16);         // 16bit
  const dataLen = wav.readUInt32LE(40);
  assert.equal(dataLen, 24000 * 2 * 2);           // 2s * 24000Hz * mono * 16bit
  assert.equal(wav.length, 44 + dataLen);
  const first = wav.readInt16LE(44);              // 淡入 → 首样本接近 0
  assert.ok(Math.abs(first) < 2000, `首样本应接近 0（淡入），实际 ${first}`);
});

check('pcmToWav 往返：数据体逐字节一致', () => {
  const pcm = Buffer.alloc(2000, 0x5a);
  const wav = pcmToWav(pcm, 16000, 1);
  assert.deepEqual(wav.subarray(44), pcm);
});

check('S16Resampler：48k→16k 长度约 1/3 + 常值保真 + 跨 chunk 连续', () => {
  const rs = new S16Resampler({ fromRate: 48000, toRate: 16000 });
  // 常值信号：插值后仍是该值
  const c1 = rs.push(Buffer.alloc(4800, 0));   // 静音块：4800B@48k = 2400样本 → 800样本 = 1600B@16k
  assert.equal(c1.length, 1600, `4800B@48k 应出 1600B@16k，实际 ${c1.length}`);
  // 非零常值：0x1111 = 4369
  const rs2 = new S16Resampler({ fromRate: 48000, toRate: 16000 });
  const constBuf = Buffer.alloc(960);
  for (let i = 0; i < 480; i++) constBuf.writeInt16LE(4369, i * 2);
  const o1 = rs2.push(constBuf);
  const o2 = rs2.push(constBuf);   // 第二块跨相位连续
  assert.equal(o1.readInt16LE(0), 4369);
  assert.equal(o2.readInt16LE(0), 4369);
  assert.ok(Math.abs(o2.length - o1.length) <= 4, '跨 chunk 输出长度应稳定');
  // 同率直通：原样返回
  const rs3 = new S16Resampler({ fromRate: 16000, toRate: 16000 });
  const same = Buffer.alloc(100, 0x7f);
  assert.equal(rs3.push(same), same);
});

console.log('\n== Receiver（假 ffmpeg 进程）==');

/** 造一个假的 child_process：stdout/stderr 可手动喂数据，kill 可控。 */
function fakeProc() {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.exitCode = null;
  p.killed = false;
  p.kill = () => {
    p.killed = true;
    p.exitCode = 0;
    setTimeout(() => p.emit('close', 0, null), 5);   // 真进程 kill 后必发 close
  };
  return p;
}

/** 帧化 16k mono s16le 的一块 PCM。 */
const pcmBlock = (ms) => Buffer.alloc((16000 * ms / 1000) * 2, 0x11);

await checkAsync('正常流：PCM → level 事件 → stop 后 exit 无错误原因；ffmpeg 参数契约正确', async () => {
  let spawned = null;
  const r = new Receiver({
    deviceName: 'CABLE Output (VB-Audio Virtual Cable)',
    spawnFn: () => { if (!spawned) spawned = fakeProc(); return spawned; },
    noDataMs: 60000
  });
  const events = { level: 0, chunk: 0, error: [], exit: [] };
  r.on('level', () => events.level++);
  r.on('chunk', () => events.chunk++);
  r.on('error', (e) => events.error.push(e.reason));
  r.on('exit', (e) => events.exit.push(e));

  // 捕获 spawn 参数（contract）
  let gotArgs = null;
  const probe = new Receiver({
    deviceName: '麦克风 (测试)',
    spawnFn: (cmd, args) => { gotArgs = { cmd, args }; return fakeProc(); }
  });
  probe.start();
  assert.equal(gotArgs.cmd, 'ffmpeg');
  assert.ok(gotArgs.args.includes('audio=麦克风 (测试)'), gotArgs.args.join(' '));
  assert.ok(gotArgs.args.includes('-ar') && gotArgs.args.includes('16000'));
  assert.ok(gotArgs.args.includes('-f') && gotArgs.args.includes('s16le'));
  probe.stop();

  // 正常流
  r.start();
  const proc = spawned;
  assert.ok(proc, 'spawnFn 应被调用');
  proc.stdout.emit('data', pcmBlock(120));   // 120ms 足够填满一个电平窗口
  proc.stdout.emit('data', pcmBlock(120));
  await new Promise((res) => setTimeout(res, 200));
  assert.ok(events.level >= 1, '应发出 level 事件');
  assert.equal(events.chunk, 2);
  assert.equal(events.error.length, 0);
  const stats = r.stop();
  assert.ok(stats.bytes > 0);
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(events.exit.length, 1, 'stop 后应有一次 exit');
  assert.equal(events.exit[0].reason, '', '主动 stop 不应带错误原因');
});

await checkAsync('设备掉线：非人为退出 → error 带原因（含 stderr 尾巴）', async () => {
  let spawned = null;
  const r = new Receiver({
    deviceName: '掉线设备',
    spawnFn: () => { if (!spawned) spawned = fakeProc(); return spawned; },
    noDataMs: 60000
  });
  const errors = [];
  r.on('error', (e) => errors.push(e.reason));
  r.start();
  const proc = spawned;
  proc.stdout.emit('data', pcmBlock(100));                 // 先有数据（排掉"无数据"分支）
  proc.stderr.emit('data', Buffer.from('[dshow @ xxx] Could not run graph\n'));
  proc.exitCode = 1;
  proc.emit('close', 1, null);
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /收音中断/);
  assert.match(errors[0], /Could not run graph/, '原因应包含 stderr 尾巴');
});

await checkAsync('无数据兜底：窗口内零 PCM → error 先报（不被 stop 吞）+ 自动停止', async () => {
  let spawned = null;
  const r = new Receiver({
    deviceName: '打不开的设备',
    spawnFn: () => { if (!spawned) spawned = fakeProc(); return spawned; },
    noDataMs: 80
  });
  const errors = [];
  const exits = [];
  r.on('error', (e) => errors.push(e.reason));
  r.on('exit', (e) => exits.push(e));
  r.start();
  const proc = spawned;
  proc.stdout.emit('data', Buffer.alloc(0));   // 空块不计数
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(errors.length, 1, '应恰好报一次无数据错误');
  assert.match(errors[0], /无数据|设备未打开/);
  assert.equal(proc.killed, true, '应自动停掉进程');
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(exits.length, 1);
  assert.equal(r.running, false);
});

await checkAsync('loopback 模式：spawn 契约（powershell + -Action loop -Device）+ 采样率头解析 + 48k→16k 重采样', async () => {
  let got = null;
  let proc = null;
  const r = new Receiver({
    mode: 'loopback',
    deviceName: '扬声器 (Realtek High Definition Audio)',
    spawnFn: (cmd, args) => { got = { cmd, args }; proc = fakeProc(); return proc; },
    noDataMs: 60000
  });
  const chunks = [];
  r.on('chunk', (b) => chunks.push(b));
  r.start();
  const a = got.args.join(' ');
  assert.ok(/powershell\.exe/.test(got.cmd), got.cmd);
  assert.match(a, /-Action loop/);
  assert.match(a, /-Device 扬声器 \(Realtek High Definition Audio\)/);
  // 模拟 C# stderr 采样率头 + 48k 数据
  proc.stderr.emit('data', Buffer.from('#loopback rate=48000 ch=2 bits=32\n'));
  // 960B@48k = 480 样本 → 应出 ~160 样本 @16k
  proc.stdout.emit('data', Buffer.alloc(960, 0x22));
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(chunks.length, 1, '应收到一个重采样后的 chunk');
  assert.equal(chunks[0].length, 320, `160 样本*2B=320B，实际 ${chunks[0].length}`);
  r.stop();
  await new Promise((res) => setTimeout(res, 30));
});

console.log('\n== playWavToDevice（假 PowerShell）==');

await checkAsync('参数契约 + 成功路径', async () => {
  let got = null;
  const fake = () => {
    const p = fakeProc();
    setTimeout(() => p.emit('close', 0), 10);
    return p;
  };
  const r = await playWavToDevice({
    wavPath: 'D:\\tmp\\tone.wav', deviceId: 1, spawnFn: (cmd, args) => { got = { cmd, args }; return fake(); }
  });
  assert.ok(r);
  assert.ok(/powershell/.test(got.cmd), got.cmd);
  const a = got.args.join(' ');
  assert.match(a, /-Action play/);
  assert.match(a, /-WavPath D:\\tmp\\tone\.wav/);
  assert.match(a, /-DeviceId 1/);
});

await checkAsync('失败路径：exit 3 + stderr → reject 且文案带原因', async () => {
  const fake = () => {
    const p = fakeProc();
    // 输出必须发生在监听器挂上之后（与真实子进程一致）
    setTimeout(() => {
      p.stderr.emit('data', Buffer.from('waveout play failed: code 100001'));
      p.emit('close', 3);
    }, 10);
    return p;
  };
  await assert.rejects(
    () => playWavToDevice({ wavPath: 'x.wav', deviceId: 2, spawnFn: () => fake() }),
    (e) => /播放失败.*100001/.test(e.message)
  );
});

console.log(bad ? `\n${bad} 项失败\n` : '\n全部通过\n');
process.exit(bad ? 1 : 0);
