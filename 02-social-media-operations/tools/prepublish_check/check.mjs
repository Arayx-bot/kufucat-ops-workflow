import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL,fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const ROOT = path.resolve(process.env.KUFUCAT_PROJECT_ROOT || fileURLToPath(new URL('../../../',import.meta.url)));
let localConfig={};try{localConfig=JSON.parse(await readFile(new URL('./prepublish.local.json',import.meta.url),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const CONTRACT = process.env.KUFUCAT_PREPUBLISH_CONTRACT || localConfig.contract || path.join(ROOT,'config/prepublish-contract.json');
const MEDIA_ORIGIN = process.env.KUFUCAT_MEDIA_ORIGIN || localConfig.mediaOrigin;
export const sha = data => createHash('sha256').update(data).digest('hex');
export const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
export const fingerprint = value => sha(stable(value));
const readJSON = async file => JSON.parse(await readFile(file, 'utf8'));
const putJSON = async (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
export function captionFacts(text, platform, caps) {
  const hashtags = text.match(/#[\p{L}\p{N}_]+/gu) || [];
  return { utf16_chars: text.length, codepoints: [...text].length, hashtags,
    within_limits: text.length <= caps.caption_max_chars && (!caps.caption_max_hashtags || hashtags.length <= caps.caption_max_hashtags),
    unexpected_buffer_tag: hashtags.some(t => t.toLowerCase() === '#buffer'),
    placeholders: /(?:\bUntitled Video\b|\[INSERT|\{\{)/i.test(text), platform };
}
export function mediaIssues(probe, platform, caps) {
  const v = probe.streams.find(s => s.codec_type === 'video');
  const a = probe.streams.find(s => s.codec_type === 'audio');
  if (!v || !a) return ['missing video/audio stream'];
  const fps = v.avg_frame_rate.split('/').reduce((x, y) => Number(x) / Number(y));
  const seconds = Number(probe.format.duration), size = Number(probe.format.size);
  const issues = [];
  if (v.codec_name !== 'h264' || a.codec_name !== 'aac' || v.pix_fmt !== 'yuv420p') issues.push('codec/pixel format');
  if (v.width * 16 !== v.height * 9) issues.push('project requires 9:16');
  if (platform !== 'tiktok' && (v.width !== 720 || v.height !== 1280 || fps !== 30 || v.r_frame_rate !== v.avg_frame_rate)) issues.push('project Meta720/CFR30 profile');
  const minW = caps.min_width || caps.reel_min_width || 720, minH = caps.min_height || caps.reel_min_height || 1280;
  if (v.width < minW || v.height < minH) issues.push('resolution');
  if (fps < caps.fps_min || fps > caps.fps_max) issues.push('frame rate');
  const minS = caps.video_min_seconds_conservative || caps.video_min_seconds || caps.reel_min_seconds;
  const maxS = caps.video_max_seconds || caps.reel_max_seconds;
  if (seconds < minS || seconds > maxS) issues.push('duration');
  if (caps.file_size_below_mb ? size >= caps.file_size_below_mb * 1e6 : size > caps.file_size_max_gb * 1e9) issues.push('file size');
  for (const [label, stream, limit] of [['video bitrate', v, caps.video_bitrate_below_bps], ['audio bitrate', a, caps.audio_bitrate_below_bps]]) {
    if (limit && (!Number.isFinite(Number(stream.bit_rate)) || Number(stream.bit_rate) >= limit)) issues.push(`${label}: ${stream.bit_rate ?? 'unknown'} >= ${limit}`);
  }
  return issues;
}
export function gate(registry, checks, platform, phases, payloadFingerprint, now = Date.now()) {
  if (!['facebook', 'instagram', 'tiktok'].includes(platform) || !phases.length || phases.some(p => !registry.some(r => r.phase === p))) return { result: 'blocked', invalid_record: true, blockers: [{ id: 'INVALID_SCOPE', result: 'unknown' }], warnings: [] };
  const duplicate = new Set(checks.map(c => c.id)).size !== checks.length;
  const invalid = duplicate || checks.some(c => !registry.some(r => r.id === c.id));
  const results = registry.filter(r => (!r.platform || r.platform === 'shared' || r.platform === platform) && phases.includes(r.phase)).map(rule => {
    const c = checks.find(c => c.id === rule.id);
    let result = c?.result || 'unknown';
    const age = now - Date.parse(c?.checked_at);
    if (!['pass', 'fail', 'unknown', 'not_applicable'].includes(result) || !c?.checker || !c?.evidence?.length || c.payload_fingerprint !== payloadFingerprint || !Number.isFinite(age) || age < -60000 || age > (c.max_age_seconds || 900) * 1000) result = 'unknown';
    if (result === 'not_applicable' && (!c.applicability_verified || !c.applicability_reason)) result = 'unknown';
    return { id: rule.id, severity: rule.severity, result };
  });
  const blockers = results.filter(r => r.severity === 'required' && !['pass', 'not_applicable'].includes(r.result));
  return { result: invalid || !checks.length || blockers.length ? 'blocked' : 'checks_passed_not_authorization', invalid_record: invalid || !checks.length, blockers, warnings: results.filter(r => r.severity === 'advisory' && !['pass', 'not_applicable'].includes(r.result)) };
}
export function contentReadiness(post, media, snapshot, config, now = Date.now()) {
  const platform = post.platform;
  const governance = config.governance || {};
  const registryAsset = governance.registry_assets?.[platform];
  const targetChannel = governance.platform_targets?.[platform];
  const disclosure = governance.disclosure_requirements?.[platform];
  const channel = snapshot.channels.find(c => c.id === post.payload.channel_id);
  const plannedAt = config.planned_at_utc?.[platform];
  const blockers = [];
  if (!registryAsset || registryAsset.id !== post.payload.asset_id || !['approved', 'current'].includes(registryAsset.status)) blockers.push('asset_not_current_or_approved');
  if (!media?.hash_match) blockers.push('asset_sha_mismatch');
  if (post.technical_issues.length) blockers.push('platform_media_profile_failed');
  if (!post.copy_matches) blockers.push('caption_mismatch');
  if (!post.source_matches) blockers.push('distribution_source_mismatch');
  if (!post.timeline_matches || !post.offset_matches || !post.processing_done) blockers.push('video_metadata_incomplete');
  if (!post.title_matches) blockers.push('facebook_title_mismatch');
  if (!targetChannel || targetChannel !== post.payload.channel_id || channel?.service !== platform || channel?.isDisconnected || channel?.isLocked) blockers.push('platform_target_invalid');
  if (!governance.license_reference) blockers.push('license_requirement_undefined');
  if (!disclosure) blockers.push('disclosure_requirement_undefined');
  if (['instagram', 'tiktok'].includes(platform) && post.payload.disclosures.ai_generated !== true) blockers.push('ai_disclosure_metadata_missing');
  if (platform === 'instagram' && post.payload.share_to_feed !== true) blockers.push('instagram_share_to_feed_missing');
  if (!plannedAt || !Number.isFinite(Date.parse(plannedAt)) || Date.parse(plannedAt) <= now) blockers.push('planned_time_missing_or_past');
  const manual_gates = [];
  if (platform === 'tiktok' && disclosure?.tiktok_brand_disclosure?.required === true && disclosure.tiktok_brand_disclosure.verification_mode !== 'automatic') {
    manual_gates.push('tiktok_content_disclosure_your_brand_on');
  }
  return {
    result: blockers.length ? 'blocked' : 'content_ready',
    schedule_result: blockers.length ? 'blocked' : manual_gates.length ? 'manual_gate' : 'ready_to_schedule',
    blockers,
    manual_gates,
    planned_at_utc: plannedAt || null,
    ttl_applies: false
  };
}
async function scopedFile(file) {
  const absolute = await realpath(file);
  if (!absolute.startsWith(ROOT + path.sep)) throw new Error('File outside project');
  return absolute;
}
async function remoteHash(url, expectedSize) {
  if (!MEDIA_ORIGIN || new URL(url).origin !== new URL(MEDIA_ORIGIN).origin) throw new Error('Only project public media origin allowed');
  const { stdout } = await execFile('curl', ['--silent', '--show-error', '--max-time', '30', '--proto', '=https', '--max-filesize', String(Math.max(expectedSize * 2, 1e6)), '--include', url], { timeout: 35000, encoding: 'buffer', maxBuffer: Math.max(expectedSize * 2 + 65536, 2e6) });
  let body = stdout, header = '';
  do {
    const boundary = body.indexOf('\r\n\r\n');
    if (boundary < 0) throw new Error('Missing HTTP headers');
    header = body.subarray(0, boundary).toString('utf8'); body = body.subarray(boundary + 4);
  } while (/^HTTP\/\S+ 200 Connection established/i.test(header) || /^HTTP\/\S+ 1\d\d/.test(header));
  return { status: Number(header.match(/^HTTP\/\S+ (\d+)/)?.[1]), final_url: url, content_type: header.match(/^content-type:\s*(.+)$/im)?.[1]?.trim(), bytes: body.length, sha256: sha(body), checked_at: new Date().toISOString(), access: 'anonymous full GET; in-memory hash, no remote media saved; no redirects followed' };
}
export async function collect(configFile) {
  configFile = await scopedFile(configFile);
  const dir = path.dirname(configFile), config = await readJSON(configFile);
  const snapshot = await readJSON(await scopedFile(path.join(dir, config.snapshot_file)));
  const contract = await readJSON(CONTRACT);
  const media = {};
  for (const asset of Object.values(config.approved)) {
    if (media[asset.id]) continue;
    const file = await scopedFile(asset.path), data = await readFile(file);
    const probe = JSON.parse((await execFile('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { timeout: 30000 })).stdout);
    let decode;
    try { const r = await execFile('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], { timeout: 60000 }); decode = { result: 'pass', stderr: r.stderr }; }
    catch (e) { decode = { result: 'fail', stderr: e.stderr || e.message }; }
    const level = await execFile('ffmpeg', ['-nostdin', '-hide_banner', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { timeout: 30000 });
    const audioHash = await execFile('ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-map', '0:a:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-'], { timeout: 30000 });
    let remote;
    try { remote = await remoteHash(asset.url, data.length); } catch (e) { remote = { result: 'unknown', error: e.message }; }
    media[asset.id] = { path: file, sha256: sha(data), expected_sha256: asset.sha256, hash_match: sha(data) === asset.sha256, probe, decode,
      audio_stream_hash: audioHash.stdout.trim(), audio_level: level.stderr.match(/(?:mean_volume|max_volume):[^\n]+/g), remote,
      remote_matches: remote.status === 200 && remote.content_type?.includes('video/mp4') && remote.sha256 === asset.sha256 && remote.bytes === data.length };
  }
  const posts = snapshot.posts.map(post => {
    const platform = post.channelService, approved = config.approved[platform], m = media[approved.id], v = post.assets[0]?.video;
    const expectedOffset = typeof config.expected_thumbnail_offset_ms === 'object' ? config.expected_thumbnail_offset_ms[platform] : config.expected_thumbnail_offset_ms;
    const payload = { campaign_id: config.campaign_id, content_id: config.content_id, creative_version: config.creative_version, asset_id: approved.id, asset_sha256: m.sha256,
      platform, organization_id: snapshot.organization.id, channel_id: post.channelId, caption: post.text, title: platform === 'facebook' ? v?.title : null,
      hashtags: captionFacts(post.text, platform, contract.platform_capabilities[platform]).hashtags, thumbnail_offset_ms: v?.thumbnailOffset,
      disclosures: { ai_generated: post.metadata?.isAiGenerated ?? null, own_brand: 'unverified' }, visibility: 'unverified', share_to_feed: post.metadata?.shouldShareToFeed ?? null,
      scheduling_mode: post.schedulingType, planned_at_utc: post.dueAt, platform_config_version: contract.contract_version };
    return { post_id: post.id, platform, payload, payload_fingerprint: fingerprint(payload), caption: captionFacts(post.text, platform, contract.platform_capabilities[platform]),
      copy_matches: post.text === config.expected_captions[platform], technical_issues: mediaIssues(m.probe, platform, contract.platform_capabilities[platform]),
      source_matches: post.assets.length === 1 && post.assets[0].source === approved.url, offset_matches: v?.thumbnailOffset === expectedOffset,
      timeline_matches: Math.abs(Number(m.probe.format.duration) - approved.expected_duration) < 0.002 && Number(m.probe.streams.find(s => s.codec_type === 'video')?.nb_frames) === approved.expected_frames && v?.durationMs === Math.round(approved.expected_duration * 1000) && v?.thumbnailOffset >= 0 && v?.thumbnailOffset < v?.durationMs,
      processing_done: v?.isVideoProcessing === false, title_matches: platform !== 'facebook' || v?.title === config.expected_fb_title,
      draft_no_time: post.status === 'draft' && post.dueAt === null && post.sentAt === null && post.error === null };
  });
  const result = { collected_at: new Date().toISOString(), snapshot_captured_at: snapshot.captured_at, input_fingerprint: fingerprint({ config, snapshot, contract }), execution_enabled: false, media, posts };
  await putJSON(path.join(dir, 'deterministic-evidence.json'), result);
  console.log(JSON.stringify({ evidence: path.join(dir, 'deterministic-evidence.json'), remote: Object.fromEntries(Object.entries(media).map(([k, m]) => [k, m.remote_matches])), posts: posts.map(({ platform, technical_issues, draft_no_time }) => ({ platform, technical_issues, draft_no_time })) }, null, 2));
}
export async function evaluate(configFile) {
  configFile = await scopedFile(configFile); const dir = path.dirname(configFile);
  const contract = await readJSON(CONTRACT);
  const config = await readJSON(configFile), snapshot = await readJSON(path.join(dir, config.snapshot_file));
  const facts = await readJSON(path.join(dir, 'deterministic-evidence.json'));
  const reviews = await readJSON(path.join(dir, 'review-records.json'));
  if (facts.input_fingerprint !== fingerprint({ config, snapshot, contract })) throw new Error('Inputs changed: recollect and review');
  const reviewBindingValid = reviews.input_fingerprint === facts.input_fingerprint;
  const outputs = facts.posts.map(post => {
    const records = reviewBindingValid ? reviews.posts.find(p => p.post_id === post.post_id)?.checks || [] : [];
    if (new Set(records.map(c => c.id)).size !== records.length || records.some(c => !contract.rule_registry.some(r => r.id === c.id))) throw new Error('Duplicate/unknown review rule');
    const media = facts.media[post.payload.asset_id];
    const remote = snapshot.posts.find(p => p.id === post.post_id);
    const channel = snapshot.channels.find(c => c.id === post.payload.channel_id);
    const deterministic = {
      A01: media.hash_match, A02: post.technical_issues.length === 0, A03: post.timeline_matches && post.offset_matches,
      L01: media.remote_matches ? true : media.remote.error ? null : false,
      B01: channel ? !channel.isDisconnected && !channel.isLocked : null,
      B06: post.draft_no_time,
      T03: snapshot.pagination?.hasNextPage === false && snapshot.posts.filter(p => p.channelService === post.platform && p.assets.some(a => a.source === remote.assets[0].source)).length === 1,
      [post.platform === 'instagram' ? 'IG02' : post.platform === 'tiktok' ? 'TT02' : 'FB02']: post.technical_issues.length === 0
    };
    const checks = contract.rule_registry.map(rule => {
      if (rule.platform && rule.platform !== 'shared' && rule.platform !== post.platform) return { id: rule.id, result: 'not_applicable', checker: 'platform-scope', evidence: [post.platform], applicability_verified: true, applicability_reason: 'Other platform', checked_at: facts.collected_at, payload_fingerprint: post.payload_fingerprint };
      const review = records.find(c => c.id === rule.id);
      if (Object.hasOwn(deterministic, rule.id)) return { id: rule.id, result: deterministic[rule.id] === null ? 'unknown' : deterministic[rule.id] ? 'pass' : 'fail', checker: 'read-only-deterministic-checker', evidence: [`deterministic-evidence.json#${post.post_id}/${rule.id}`, 'buffer-snapshot.json'], reason: rule.id === 'A02' || rule.id.endsWith('02') ? post.technical_issues.join('; ') : review?.reason, checked_at: snapshot.captured_at, max_age_seconds: 900, payload_fingerprint: post.payload_fingerprint };
      return review || { id: rule.id, result: 'unknown', reason: 'Missing check record' };
    });
    const contentPhases = ['content_prepare', 'media_ready', 'draft_verify'];
    const readiness = contentReadiness(post, media, snapshot, config);
    return { ...post, checks, content_ready_gate: { result: readiness.result, blockers: readiness.blockers, ttl_applies: false },
      schedule_ready_gate: { result: readiness.schedule_result, blockers: readiness.blockers, manual_gates: readiness.manual_gates, planned_at_utc: readiness.planned_at_utc, ttl_applies: false },
      content_gate: gate(contract.rule_registry, checks, post.platform, contentPhases, post.payload_fingerprint),
      unattended_gate: gate(contract.rule_registry, checks, post.platform, contract.action_gates.finalize_draft.phases, post.payload_fingerprint),
      scheduling_gate: gate(contract.rule_registry, checks, post.platform, contract.action_gates.schedule.phases, post.payload_fingerprint),
      live_prepublish_gate: gate(contract.rule_registry, checks, post.platform, contract.action_gates.live_prepublish.phases, post.payload_fingerprint),
      review_binding_valid: reviewBindingValid, execution_enabled: false };
  });
  await putJSON(path.join(dir, 'check-results.json'), { evaluated_at: new Date().toISOString(), scope: config.scope, execution_enabled: false, posts: outputs });
  console.log(JSON.stringify(outputs.map(p => ({ platform: p.platform, content_gate: p.content_gate, unattended_gate: p.unattended_gate })), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, config] = process.argv.slice(2);
  if (!config || !['collect', 'evaluate'].includes(command)) throw new Error('Usage: node check.mjs collect|evaluate /absolute/path/audit-config.json');
  await ({ collect, evaluate })[command](config);
}
