/**
 * Cloudflare Worker — Arc Meeting Lobby
 *
 * 一个完整的会议入口:
 *   /                  → 输入姓名表单 (新建通话)
 *   /?meetingId=XYZ    → 同上, 但加入已存在的通话 (通过二维码邀请抵达)
 *   POST /api/join     → 调 RealtimeKit REST API, 返回 authToken
 *   /pll.html          → 通过 [assets] 绑定 serve 现有 Arc 客户端
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 部署:
 *
 *   arc-meeting/
 *   ├── wrangler.toml
 *   ├── src/worker.js        ← 本文件
 *   └── public/pll.html      ← Arc 客户端 (会被静态 serve)
 *
 *   wrangler.toml:
 *     name = "arc-meeting"
 *     main = "src/worker.js"
 *     compatibility_date = "2025-01-13"
 *     [assets]
 *     directory = "./public"
 *     binding = "ASSETS"
 *
 *   设置 secrets (terminal):
 *     wrangler secret put CF_ACCOUNT_ID
 *     wrangler secret put CF_API_TOKEN     # 权限: Realtime — Edit
 *     wrangler secret put RTK_APP_ID
 *     # 可选: wrangler secret put RTK_PRESET_NAME   (默认 "group_call_host")
 *
 *   wrangler deploy
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 准备 CF 端:
 *   1) Cloudflare Dashboard → Realtime → RealtimeKit → Create App
 *      (建议从 dashboard 创建, 会自动带 group_call_host / group_call_participant 等默认 preset)
 *   2) 拷贝 App ID
 *   3) Profile → API Tokens → Create Token → 选 "Realtime" 权限
 */

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // 后端 API: 创建/加入会议, 返回 authToken
        if (url.pathname === '/api/join' && request.method === 'POST') {
            return handleJoin(request, env);
        }

        // 入口表单 (新建 or 邀请加入)
        if (url.pathname === '/' || url.pathname === '') {
            return new Response(joinPage(url), {
                headers: {
                    'content-type': 'text/html; charset=utf-8',
                    'cache-control': 'no-store'
                }
            });
        }

        // 其它路径 → 交给静态资源 (pll.html 等)
        if (env.ASSETS) return env.ASSETS.fetch(request);
        return new Response('Not Found', { status: 404 });
    }
};

// ============================================================
//  /api/join — 调 RealtimeKit REST API
// ============================================================
async function handleJoin(request, env) {
    // 1. 校验环境变量
    const missing = ['CF_ACCOUNT_ID', 'CF_API_TOKEN', 'RTK_APP_ID'].filter((k) => !env[k]);
    if (missing.length) {
        return jsonError(`Worker 未配置: 缺少 ${missing.join(', ')}`, 500);
    }

    // 2. 解析请求体
    let body;
    try {
        body = await request.json();
    } catch {
        return jsonError('请求体不是合法 JSON', 400);
    }

    const name = (body.name || '').trim().slice(0, 64);
    if (!name) return jsonError('姓名不能为空', 400);

    const accountId  = env.CF_ACCOUNT_ID;
    const apiToken   = env.CF_API_TOKEN;
    const appId      = env.RTK_APP_ID;
    const presetName = env.RTK_PRESET_NAME || 'group_call_host';

    // RealtimeKit API 基址 (注意: app_id 直接接在 /kit/ 后面, 不是 /kit/apps/{id})
    const apiBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/realtime/kit/${appId}`;
    const apiHeaders = {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type':  'application/json'
    };

    // 3. 若没 meetingId, 先创建一个新 meeting
    let meetingId = (body.meetingId || '').trim();
    let isHost = false;
    if (!meetingId) {
        isHost = true;
        const meetingRes = await fetch(`${apiBase}/meetings`, {
            method:  'POST',
            headers: apiHeaders,
            body:    JSON.stringify({ title: `Arc · ${name}` })
        });
        const meetingJson = await meetingRes.json().catch(() => ({}));
        if (!meetingRes.ok || meetingJson.success === false) {
            console.error('[Worker] create meeting failed', meetingRes.status, meetingJson);
            return jsonError(
                `创建会议失败 (${meetingRes.status}): ${meetingJson.errors?.[0]?.message || '未知错误'}`,
                502
            );
        }
        meetingId = meetingJson.result?.id;
        if (!meetingId) return jsonError('会议创建成功但响应中无 id', 502);
    }

    // 4. 把 participant 加进 meeting → 拿到 authToken
    const participantRes = await fetch(`${apiBase}/meetings/${meetingId}/participants`, {
        method:  'POST',
        headers: apiHeaders,
        body:    JSON.stringify({
            name,
            preset_name:           presetName,
            custom_participant_id: crypto.randomUUID()
        })
    });
    const participantJson = await participantRes.json().catch(() => ({}));
    if (!participantRes.ok || participantJson.success === false) {
        console.error('[Worker] add participant failed', participantRes.status, participantJson);
        return jsonError(
            `加入会议失败 (${participantRes.status}): ${participantJson.errors?.[0]?.message || '未知错误'}`,
            502
        );
    }

    const authToken = participantJson.result?.token;
    if (!authToken) return jsonError('参与者创建成功但响应中无 token', 502);

    return new Response(JSON.stringify({
        authToken,
        meetingId,
        name,
        isHost,
        callPath: env.CALL_PATH || '/pll.html'
    }), {
        headers: { 'content-type': 'application/json' }
    });
}

function jsonError(message, status) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'content-type': 'application/json' }
    });
}

// ============================================================
//  HTML — 入口表单 + 成功视图 (含二维码)
// ============================================================
function joinPage(url) {
    const meetingId = url.searchParams.get('meetingId') || '';
    const origin    = url.origin;

    // 注入到客户端 JS 时用 JSON.stringify 防 XSS
    const meetingIdJSON = JSON.stringify(meetingId);
    const originJSON    = JSON.stringify(origin);
    const isInvite      = !!meetingId;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="theme-color" content="#FAFBFD">
<title>Arc · ${isInvite ? 'Join Call' : 'Start Call'}</title>
<script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>
<style>
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    html, body { margin: 0; padding: 0; min-height: 100vh; }
    body {
        font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif;
        background: radial-gradient(ellipse at top, #FAFBFD 0%, #F2F3F7 100%);
        color: #1D1D1F;
        display: flex; align-items: center; justify-content: center;
        padding: 24px;
        overflow-x: hidden;
    }
    .card {
        width: 100%; max-width: 380px;
        background: #fff;
        border-radius: 24px;
        padding: 36px 32px 28px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.8);
        animation: cardIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    @keyframes cardIn {
        from { opacity: 0; transform: translateY(12px) scale(0.96); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    .title  { font-size: 36px; font-weight: 700; letter-spacing: -0.8px; margin: 0; text-align: center; }
    .subtitle { font-size: 15px; color: #86868B; margin: 6px 0 28px; text-align: center; }
    .input {
        width: 100%; font: inherit; font-size: 17px;
        padding: 14px 16px;
        border: 1px solid rgba(0,0,0,0.08);
        border-radius: 14px;
        background: #F5F5F7; color: #1D1D1F;
        margin-bottom: 14px;
        transition: background 0.2s ease, border 0.2s ease, box-shadow 0.2s ease;
    }
    .input:focus {
        outline: none; background: #fff;
        border-color: rgba(0, 122, 255, 0.5);
        box-shadow: 0 0 0 4px rgba(0, 122, 255, 0.1);
    }
    .btn-primary {
        display: block; width: 100%;
        font: inherit; font-size: 17px; font-weight: 600;
        padding: 14px; border: none; border-radius: 14px;
        background: #1D1D1F; color: #fff;
        cursor: pointer; text-align: center; text-decoration: none;
        transition: transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1),
                    background 0.2s ease, opacity 0.2s ease;
    }
    .btn-primary:hover  { background: #2c2c2e; }
    .btn-primary:active { transform: scale(0.97); }
    .btn-primary:disabled { background: #C7C7CC; cursor: not-allowed; transform: none; }
    .err {
        color: #FF3B30; font-size: 13px;
        margin: 12px 0 0; min-height: 16px; text-align: center;
    }
    .view { transition: opacity 0.35s ease; }
    .view.hidden { display: none; }

    .greeting { font-size: 19px; font-weight: 600; margin: 0 0 4px; text-align: center; }
    .greeting .name { color: #007AFF; }

    .qr-section {
        margin-top: 24px; padding: 20px 16px 16px;
        background: #F5F5F7; border-radius: 18px; text-align: center;
    }
    .qr-section .label {
        font-size: 11px; font-weight: 600;
        color: #86868B; letter-spacing: 0.6px;
        margin: 0 0 14px; text-transform: uppercase;
    }
    #qrcode-canvas {
        display: block; margin: 0 auto;
        background: #fff; padding: 10px; border-radius: 12px;
        box-shadow: 0 4px 14px rgba(0,0,0,0.05);
        max-width: 100%;
    }
    .copy-btn {
        margin-top: 10px;
        background: transparent; color: #007AFF; border: none;
        font: inherit; font-size: 14px; font-weight: 500;
        cursor: pointer; padding: 8px 16px; border-radius: 8px;
        transition: background 0.15s ease, color 0.15s ease;
    }
    .copy-btn:hover  { background: rgba(0, 122, 255, 0.06); }
    .copy-btn.copied { color: #34C759; }
    .invite-url {
        font-size: 11px; color: #86868B;
        word-break: break-all; margin: 6px 0 0;
        font-family: 'SF Mono', ui-monospace, monospace;
    }

    @media (prefers-color-scheme: dark) {
        body { background: radial-gradient(ellipse at top, #1c1c1e 0%, #000 100%); color: #f5f5f7; }
        .card { background: #1c1c1e; box-shadow: 0 20px 60px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04); }
        .input { background: #2c2c2e; color: #f5f5f7; border-color: rgba(255,255,255,0.08); }
        .input:focus { background: #1c1c1e; }
        .input::placeholder { color: #6e6e72; }
        .btn-primary { background: #fff; color: #000; }
        .btn-primary:hover { background: #e5e5e7; }
        .btn-primary:disabled { background: #3a3a3c; color: #86868b; }
        .qr-section { background: #2c2c2e; }
        .subtitle, .greeting { color: #f5f5f7; }
        .subtitle { color: #98989D; }
        .copy-btn:hover { background: rgba(255,255,255,0.06); }
    }
</style>
</head>
<body>

<div class="card">
    <!-- Step 1: 输入姓名 -->
    <div id="form-view" class="view">
        <h1 class="title">Arc</h1>
        <p class="subtitle">${isInvite ? "You've been invited to a call" : 'Face-puppet video calls'}</p>
        <input type="text" id="name-input" class="input" placeholder="Your name" autocomplete="name" maxlength="64" autofocus>
        <button id="submit-btn" class="btn-primary">${isInvite ? 'Join Call' : 'Start Call'}</button>
        <p class="err" id="form-err"></p>
    </div>

    <!-- Step 2: 成功 → 进入通话 + 二维码邀请 -->
    <div id="success-view" class="view hidden">
        <h1 class="title">Arc</h1>
        <p class="greeting">Hey <span class="name" id="user-name"></span>, you're in.</p>
        <p class="subtitle" id="success-subtitle">Tap below to enter the call</p>
        <a id="call-link" class="btn-primary">Enter Call →</a>
        <div class="qr-section" id="qr-section">
            <p class="label">Invite someone</p>
            <canvas id="qrcode-canvas"></canvas>
            <button class="copy-btn" id="copy-btn">Copy invite link</button>
            <p class="invite-url" id="invite-url-text"></p>
        </div>
    </div>
</div>

<script>
(function () {
    'use strict';
    const meetingIdParam = ${meetingIdJSON};
    const origin = ${originJSON};

    const formView    = document.getElementById('form-view');
    const successView = document.getElementById('success-view');
    const nameInput   = document.getElementById('name-input');
    const submitBtn   = document.getElementById('submit-btn');
    const errEl       = document.getElementById('form-err');

    // 回车键提交
    nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitBtn.click();
    });

    submitBtn.addEventListener('click', async () => {
        const name = nameInput.value.trim();
        if (!name) {
            errEl.textContent = 'Please enter your name.';
            nameInput.focus();
            return;
        }

        submitBtn.disabled   = true;
        submitBtn.textContent = 'Connecting…';
        errEl.textContent    = '';

        try {
            const res = await fetch('/api/join', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ name, meetingId: meetingIdParam })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Server error');
            showSuccess(data);
        } catch (e) {
            submitBtn.disabled   = false;
            submitBtn.textContent = meetingIdParam ? 'Join Call' : 'Start Call';
            errEl.textContent    = e.message || 'Failed to join';
        }
    });

    function showSuccess(data) {
        document.getElementById('user-name').textContent = data.name;

        const callPath  = data.callPath || '/pll.html';
        const callUrl   = origin + callPath + '?authToken=' + encodeURIComponent(data.authToken);
        const inviteUrl = origin + '/?meetingId=' + encodeURIComponent(data.meetingId);

        document.getElementById('call-link').href = callUrl;
        document.getElementById('invite-url-text').textContent = inviteUrl;

        // Guest 不需要再邀请别人 (除非要的话, 也可以打开; 这里保守只给 host)
        if (!data.isHost) {
            document.getElementById('success-subtitle').textContent = "You're joining the call";
            document.getElementById('qr-section').style.display = 'none';
        }

        // 生成二维码
        const canvas = document.getElementById('qrcode-canvas');
        QRCode.toCanvas(
            canvas,
            inviteUrl,
            {
                width: 200,
                margin: 1,
                color: { dark: '#1D1D1F', light: '#FFFFFF' }  // 二维码方块永远画在白底上, 不需随主题色切换
            },
            (err) => { if (err) console.error('[QR]', err); }
        );

        // 复制按钮
        const copyBtn = document.getElementById('copy-btn');
        copyBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(inviteUrl);
            } catch {
                // 旧浏览器 fallback
                const ta = document.createElement('textarea');
                ta.value = inviteUrl;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
            }
            copyBtn.textContent = 'Copied!';
            copyBtn.classList.add('copied');
            setTimeout(() => {
                copyBtn.textContent = 'Copy invite link';
                copyBtn.classList.remove('copied');
            }, 1800);
        });

        formView.classList.add('hidden');
        successView.classList.remove('hidden');
    }
})();
</script>

</body>
</html>`;
}
