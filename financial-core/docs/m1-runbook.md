# M1 User-Task Runbook

Step-by-step for the M1 items I can't do as code. Each task has:
**Why** (spec reference) → **Steps** (clicks/commands) → **Done when** (verification).

---

## 1. GitHub branch protection on `poker-wealth/poker` main

**Why:** Spec §11.2 + CODEOWNERS file in repo root mandate "Financial Core: independent repo, min 2-person code review."

### Steps

1. Open <https://github.com/poker-wealth/poker/settings/branches>
2. Click **"Add branch protection rule"** (or **"Add rule"**)
3. Branch name pattern: `main`
4. Check these boxes:
   - [x] **Require a pull request before merging**
     - [x] Require approvals: **1** (or 2 if you have multiple reviewers; CODEOWNERS rules will require both `@fc-leads` AND `@security` for `/financial-core/src/clearing/` paths regardless)
     - [x] Dismiss stale pull request approvals when new commits are pushed
     - [x] **Require review from Code Owners**
   - [x] **Require status checks to pass before merging**
     - [x] Require branches to be up to date before merging
     - Search for and add: **`ci`** (the `ci` job from `.github/workflows/financial-core-ci.yml`)
   - [x] **Require conversation resolution before merging**
   - [x] **Restrict who can push to matching branches** (optional; pick yourself if solo)
   - [ ] Allow force pushes — **leave UNCHECKED**
   - [ ] Allow deletions — **leave UNCHECKED**
5. Click **"Create"** (or **"Save changes"**)

### Create the CODEOWNERS team handles (or replace with your username)

`CODEOWNERS` references `@poker-wealth/fc-leads`, `@poker-wealth/security`,
`@poker-wealth/infra-leads`, `@poker-wealth/product`. You have two options:

**Option A — solo dev for now:** edit `CODEOWNERS` and replace each `@poker-wealth/*-team`
with `@your-github-username` so all CODEOWNERS rules resolve to you.

**Option B — set up GitHub teams:**
1. <https://github.com/orgs/poker-wealth/teams>
2. Click **"New team"** → name: `fc-leads` → repo access: `poker` (Maintain).
3. Repeat for `security`, `infra-leads`, `product`.
4. Add yourself to all four for now.

### Done when

- Open a test PR. GitHub blocks merge until: 1 reviewer approves, CODEOWNERS approves the touched paths, CI shows green check.
- `git push origin main` (direct push) is rejected with "branch protection rule" error.

---

## 2. Bare Workflow build on physical iOS + Android (CL track Day 1 gate)

**Why:** Spec §17 + Pitfall 2 — Bare Workflow is mandatory because Managed
Workflow runs in a sandbox that can't access deep OS permissions for
Anti-Bot device detection. M1 acceptance: "Bare Workflow confirmed:
Root/jailbreak detection SDK runs on physical iOS and Android device."

### Steps

1. **Create the client package.** Same level as `financial-core/`:
   ```
   poker/
     financial-core/
     client/         <-- NEW
   ```
2. Initialize Expo Bare Workflow:
   ```
   cd poker/
   npx create-expo-app client --template bare-minimum
   cd client
   npx expo prebuild
   ```
3. Add a root/jailbreak detection SDK. Recommended:
   ```
   npm install jail-monkey
   cd ios && pod install && cd ..
   ```
4. Wire a smoke screen in `App.tsx`:
   ```tsx
   import JailMonkey from 'jail-monkey';
   import { Text, View } from 'react-native';
   export default function App() {
     return (
       <View style={{flex:1, justifyContent:'center', padding:20}}>
         <Text>Jailbroken: {JailMonkey.isJailBroken() ? 'YES' : 'NO'}</Text>
         <Text>Root: {JailMonkey.isOnExternalStorage() ? 'YES' : 'NO'}</Text>
         <Text>Debugger: {JailMonkey.isDebuggedMode() ? 'YES' : 'NO'}</Text>
       </View>
     );
   }
   ```
5. Build and run on physical devices:
   - **iOS:** `cd ios && open *.xcworkspace` → set signing team → run on a real iPhone (not simulator). The SDK requires native binary access.
   - **Android:** `npx expo run:android --device` (with a real Android device connected via USB, USB debugging on).

### Done when

- App launches on a real iPhone showing "Jailbroken: NO" (or YES if you tested on a jailbroken device).
- App launches on a real Android phone showing "Root: NO" (or YES if rooted).
- Screenshot saved to `client/docs/bare-workflow-verification.md` with the date.

### Decision point if it fails

If `npx expo prebuild` or `pod install` fails on Windows: **use macOS for the
iOS build** (Apple's signing/build chain requires macOS). Linux/WSL works
for Android. Document the OS used in the verification screenshot.

If JailMonkey doesn't detect (false negatives): defer to M2 W3+ "more
robust device fingerprint" task. The M1 acceptance just requires the SDK
runs — it doesn't have to detect 100% of cases yet.

---

## 3. Cloudflare Zero Trust tunnel + mTLS (IN track Day 5)

**Why:** Spec §11 (P0 security) + §17 — server hidden, mTLS mutual auth.

### What's needed first

You need a deployed FC server. Local dev doesn't apply here — Cloudflare
ZT requires a running origin. Three options:

- **Option A (recommended for now):** defer. Mark as "M1 W2 / M1b" infra
  milestone. The `cloudflared` install + tunnel config takes ~1 hour
  once you have a server, but the server itself is the prerequisite.
- **Option B:** stand up a dev server on AWS Singapore today
  (~30 min via Lightsail or t4g.small EC2), then complete the
  Cloudflare ZT config.
- **Option C:** test end-to-end with Cloudflared running against your
  local laptop. Useful for validation but not a production setup.

### Cloudflared minimal config (when ready)

```bash
# Install
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
chmod +x cloudflared

# Authenticate (browser flow)
./cloudflared tunnel login

# Create tunnel
./cloudflared tunnel create fairplay-fc

# Config: ~/.cloudflared/config.yml
tunnel: fairplay-fc
credentials-file: /home/ubuntu/.cloudflared/<TUNNEL-UUID>.json
ingress:
  - hostname: fc.your-domain.com
    service: http://localhost:3000
  - service: http_status:404

# Run
./cloudflared tunnel run fairplay-fc
```

mTLS setup (client cert required):
```yaml
ingress:
  - hostname: fc.your-domain.com
    service: http://localhost:3000
    originRequest:
      caPool: /path/to/ca-bundle.pem
      tlsTimeout: 10s
```

### Done when

- `curl https://fc.your-domain.com/api/v1/health` returns `{"status":"ok",...}`.
- `nmap` against the EC2 instance IP shows ZERO open ports (only Cloudflare can reach it).
- `curl https://fc.your-domain.com/api/v1/health` without a client cert → connection refused.

---

## 4. MongoDB TLS + SCRAM-SHA-256 + Redis TLS

**Why:** Spec §11 (P0 security) — encrypt traffic to data tier; auth required.

### MongoDB

If you stick with the `mongo:7.0` Docker image (current setup), edit
`docker-compose.yml`:

```yaml
services:
  mongodb:
    image: mongo:7.0
    command:
      - '--replSet'
      - 'rs0'
      - '--bind_ip_all'
      - '--tlsMode'
      - 'requireTLS'
      - '--tlsCertificateKeyFile'
      - '/etc/ssl/mongodb.pem'
      - '--auth'
    volumes:
      - ./infra/tls/mongodb.pem:/etc/ssl/mongodb.pem:ro
      - mongo-data:/data/db
```

Generate a self-signed cert for local dev:
```bash
mkdir -p infra/tls
openssl req -newkey rsa:2048 -nodes -x509 -days 365 \
  -keyout infra/tls/mongodb.key \
  -out infra/tls/mongodb.crt \
  -subj '/CN=localhost'
cat infra/tls/mongodb.crt infra/tls/mongodb.key > infra/tls/mongodb.pem
```

Then update `MONGO_URI` in `.env`:
```
MONGO_URI=mongodb://fc-user:fc-pass@127.0.0.1:27017/fairplay-fc?replicaSet=rs0&directConnection=true&tls=true&tlsAllowInvalidCertificates=true
```

(For production, `tlsAllowInvalidCertificates=false` and use a real CA-signed cert.)

### Redis

```yaml
services:
  redis:
    image: redis:7-alpine
    command:
      - 'redis-server'
      - '--tls-port'
      - '6379'
      - '--port'
      - '0'
      - '--tls-cert-file'
      - '/etc/ssl/redis.crt'
      - '--tls-key-file'
      - '/etc/ssl/redis.key'
      - '--tls-ca-cert-file'
      - '/etc/ssl/ca.crt'
      - '--requirepass'
      - 'CHANGE-ME-LOCALLY'
    volumes:
      - ./infra/tls:/etc/ssl:ro
```

Then update `REDIS_URL`:
```
REDIS_URL=rediss://:CHANGE-ME-LOCALLY@127.0.0.1:6379
```

(The `s` in `rediss://` is the TLS scheme.)

### `rename-command` for dangerous Redis commands

In Redis container args:
```yaml
- '--rename-command'
- 'FLUSHALL'
- ''
- '--rename-command'
- 'FLUSHDB'
- ''
- '--rename-command'
- 'CONFIG'
- 'CONFIG_INTERNAL_F00B4R'
```

### Done when

- `npm run mongo:rs:start` brings up the stack with TLS enabled.
- `npm test` still passes (MongoMemoryReplSet bypasses Docker so it's unaffected).
- `npm run dev` connects successfully via `rediss://` and `mongodb://...&tls=true`.
- Connecting without TLS is refused.

---

## 5. nmap zero open ports

**Why:** Spec §M1 acceptance — server fully hidden, only Cloudflare reaches it.

### Steps (after task 3 above is done)

1. From any external machine (NOT the EC2 instance itself):
   ```bash
   nmap -Pn -p 1-65535 <YOUR-EC2-PUBLIC-IP>
   ```
2. Expected output: `0 open ports` or `All 65535 scanned ports on X are filtered`.
3. If port 22 (SSH) shows open: that's fine for ops access — but harden by:
   - SSH-key-only auth (no password)
   - Restrict source IP via security group to your VPN / office IP
4. If anything else shows open: review your security group / iptables /
   Cloudflare ZT config. Nothing else should be exposed.

### Done when

- nmap output saved to `infra/m1-nmap-output.txt` showing only port 22
  (or zero ports if SSH is via Cloudflare ZT too).

---

## 6. M1 schema review session

**Why:** Spec W1 Day 5 gate. **THIS IS WHAT BLOCKS W2.**

### Steps

1. Read [docs/m1-schema-review.md](m1-schema-review.md) end-to-end (~15 min).
2. For each section, mark:
   - **APPROVE** — paste/edit the line, leave a checkmark.
   - **CHANGES REQUESTED** — write what needs to change.
3. Commit your marked-up version:
   ```bash
   cd poker
   git add financial-core/docs/m1-schema-review.md
   git commit -m "M1 schema review: approve sections X, Y, Z; changes requested on N"
   git push
   ```
4. For any "CHANGES REQUESTED" sections: open them as GitHub issues so we
   can track resolution before W2 starts.

### Done when

- Every section in the schema-review packet has APPROVE or CHANGES REQUESTED marked.
- Final sign-off line at the bottom is filled in.
- Any CHANGES REQUESTED items are either resolved (new commits) OR explicitly deferred to a tracked milestone.

---

## Order of operations

If you're doing all of these, this is the most efficient order:

1. **Schema review** (15 min, no infra needed) — unblocks W2.
2. **GitHub branch protection** (5 min) — protects what we've already pushed.
3. **(Optional now)** Bare Workflow / Cloudflare ZT / MongoDB TLS / nmap — these
   can all be deferred to "M1b infrastructure" if you want to keep code velocity.
   The spec's 28-week plan splits M1 into M1a (Financial Core) and M1b
   (Infrastructure) — picking that split is reasonable here.

If you want to **declare M1 complete TODAY** with the minimum gates:
- Schema review APPROVED → done.
- Branch protection ON → done.
- Other infra items → tracked under "M1b infrastructure" milestone label,
  scheduled with M2.
