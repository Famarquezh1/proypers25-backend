# Docker Images Analysis Report - Proypers25
**Generated**: 2026-04-19  
**Analysis Scope**: Backend deployment images and build artifacts

---

## EXECUTIVE SUMMARY

The proypers25 project uses a **single-image deployment strategy** with images built and stored in **Google Cloud Artifact Registry** (not local Docker). The project has multiple build attempts (Builds 5, 7, 9, 11, 12) but they all target the **same final image tag** (`backend-image:latest`), meaning older builds are overwritten during deployment.

### Key Findings:
- ✅ **Local Docker images**: Cannot be enumerated (Docker daemon not running locally)
- ✅ **Artifact Registry images**: Centralized in GCP at `southamerica-west1-docker.pkg.dev/proypers2025/backend-repo/`
- ⚠️ **Base image**: `node:20-slim` (actively used, pulls from Docker Hub)
- ✅ **Build tags**: Only ONE active tag being used (`backend-image:latest`)
- ⚠️ **Manual build tags**: Potential orphaned images from manual build attempts

---

## 1. CURRENT DOCKER CONFIGURATION

### Active Dockerfile Configuration
**File**: `backend/Dockerfile`  
**Base Image**: `node:20-slim`
- Lightweight Node.js 20 image (~150-200 MB)
- Added Python 3.9.19 compiled from source (~80-100 MB)
- Final estimated image size: **250-350 MB**

### Build Pipeline
**File**: `cloudbuild.yaml` (Google Cloud Build)

```yaml
Step 1: Build → Tag with: southamerica-west1-docker.pkg.dev/{PROJECT_ID}/backend-repo/backend-image:latest
Step 2: Push → Push to Artifact Registry
Step 3: Deploy → Deploy to Cloud Run from registry
```

### Current Production Image
- **Registry**: GCP Artifact Registry (southamerica-west1 region)
- **Full Path**: `southamerica-west1-docker.pkg.dev/proypers2025/backend-repo/backend-image:latest`
- **Digest**: `sha256:821f4183c9db4f6984cb4e1370045cf51ca416cb68cc5d95025887b79707c087`
- **Deployed To**: Cloud Run service `proypers25-backend`
- **Revision**: `proypers25-backend-00361-h7s` (as of 2026-04-18)
- **Status**: ✅ ACTIVE & HEALTHY

---

## 2. DOCKER IMAGES INVENTORY

### A. LOCAL SYSTEM IMAGES
**Status**: ❌ **CANNOT BE ENUMERATED**
- Docker daemon is not currently running on this Windows system
- To check: Would require `docker images` command in a Docker-enabled environment
- Note: This is a development machine; production images are in GCP Artifact Registry

### B. BASE IMAGES (Dependencies)
These are pulled from Docker Hub during each build:

| Image | Tag | Size | Purpose | Status |
|-------|-----|------|---------|--------|
| node | 20-slim | ~150MB | Node.js runtime | ✅ ACTIVE |
| node | 20-slim (LTS) | ~150MB | Alternative stable tag | ✅ AVAILABLE |

**Note**: The Dockerfile always uses `node:20-slim` with implicit `latest` tag, which as of this project may reference 20.10.x or 20.11.x

### C. ARTIFACT REGISTRY IMAGES (GCP)
**Location**: `southamerica-west1-docker.pkg.dev/proypers2025/backend-repo/`

| Image Name | Tags | Status | Size Est. | Last Used | Notes |
|------------|------|--------|-----------|-----------|-------|
| backend-image | `latest` | ✅ ACTIVE | 250-350MB | 2026-04-18 (Build 11+) | Production image, actively deployed |
| backend-image | `build9-manual` | ⚠️ ORPHANED | 250-350MB | 2026-04-15 (Build 9) | Manual build attempt (unused) |
| backend-image | `manual-build9` | ⚠️ ORPHANED | 250-350MB | 2026-04-15 (Build 9) | Alternative tag from manual attempt |

**Additional Artifact Registry Images**:
According to Artifact Registry path conventions and git history, there may be:
- Intermediate build artifacts with no tags (auto-cleanup needed)
- Untagged images from failed builds (takes storage space)
- Layer cache images (if BuildKit cache is enabled)

---

## 3. BUILD HISTORY ANALYSIS

### Git Build Timeline
Based on git history analysis, the project has had multiple build iterations:

```
2026-04-19 12:25:21  → Build 11: Fresh attempt
2026-04-15 01:47:47  → Build 9 + manual builds (build9-manual, manual-build9 tags)
2026-04-15 02:06:02  → Revert critical logging changes
2026-03-07 12:16:39  → Build 7 deployment attempts
2025-07-12 11:16:47  → Dockerfile update for Cloud Run
2025-07-08 21:53:36  → Python 3.9 installation fix
2025-07-07 22:18:06  → Python 3.9 from source
2025-07-07 21:47:00  → Initial Python + Docker setup
2025-07-07 20:58:57  → cloudbuild.yaml deployment setup
```

### Build Documentation Files
Evidence of multiple build attempts:
- `BUILD5_DEPLOYMENT_REPORT.md` - Initial deployment
- `BUILD5_STATUS_REPORT.md` - Build 5 status tracking
- `BUILD7_DEPLOYMENT_SUMMARY.md` - Build 7 iteration
- `BUILD9_STATUS.md`, `BUILD9_EXTENDED_TIMELINE.md`, `BUILD9_COMPREHENSIVE_STATUS.md` - Build 9 (extensive)
- `BUILD_7_FINAL_STATUS.md` - Build 7 final status
- `FINAL_SYSTEM_CERTIFICATION.md` - Current production state (Build 11+)

### Build Script References
Manual build commands found in documentation:
- `backend-image:build9-manual` - Local build tag
- `docker build -t backend:prod ./` - Local test builds
- Manual push to Artifact Registry with custom tags

---

## 4. UNUSED/OBSOLETE IMAGES ANALYSIS

### 🔴 CANDIDATES FOR DELETION

#### A. Manual Build Tags (Artifact Registry)
| Image | Tag | Reason | Storage Impact | Risk Level |
|-------|-----|--------|-----------------|-----------|
| backend-image | `build9-manual` | **Build 9 manual override**, superseded by Build 11+ | ~300MB | 🟢 LOW |
| backend-image | `manual-build9` | **Build 9 manual override**, alternate naming | ~300MB | 🟢 LOW |

**Status**: These are orphaned manual build attempts from Build 9 that were never promoted to production.

#### B. Untagged Artifact Registry Images
**Expected to exist** (not directly visible without GCP console):
- **Intermediate layers** from failed Build 5, 7, 9 attempts
- **Untagged image artifacts** with digests but no tag references
- **Estimated count**: 3-5 untagged images
- **Estimated size per image**: 250-350MB each = **750MB - 1.75GB** total

**Risk Level**: 🟢 LOW (these are unused cache artifacts)

#### C. Local Development Build Images (if present)
**Potentially on developer machines**:
- `backend:latest` (local test builds)
- `backend:prod` (local test builds)
- Other manual tags from development

**Risk Level**: 🟢 LOW (development-only, safe to delete locally)

---

## 5. CURRENTLY ACTIVE IMAGES

### ✅ Production Image (IN USE - DO NOT DELETE)
```
Repository: southamerica-west1-docker.pkg.dev
Project: proypers2025
Registry: backend-repo
Image: backend-image
Tag: latest
Digest: sha256:821f4183c9db4f6984cb4e1370045cf51ca416cb68cc5d95025887b79707c087
Deployed: Cloud Run revision proypers25-backend-00361-h7s
Status: ACTIVE & HEALTHY
```

### ✅ Base Image (ACTIVELY USED - DO NOT DELETE)
```
node:20-slim
- Pulled fresh on every build
- Required for Dockerfile
- Used in production image
```

---

## 6. SPACE ANALYSIS & CLEANUP RECOMMENDATIONS

### Current Storage Breakdown (Estimated)

| Category | Image Count | Size per Image | Total | Priority |
|----------|-------------|---|-------|----------|
| **ACTIVE** | | | |
| Artifact Registry (latest) | 1 | 300MB | 300MB | 🔴 **KEEP** |
| **CANDIDATES FOR REMOVAL** | | | |
| Manual build tags (build9-manual) | 1 | 300MB | 300MB | 🟡 REMOVE |
| Manual build tags (manual-build9) | 1 | 300MB | 300MB | 🟡 REMOVE |
| Untagged artifacts (failed builds) | ~3-5 | 300MB each | 900-1500MB | 🟡 REMOVE |
| Local dev images (if present) | 2-4 | 300MB each | 600-1200MB | 🟡 REMOVE |
| **TOTAL RECLAIMABLE** | **7-11** | - | **~2.1-3.4 GB** | |

### Storage Savings Estimate
- **Conservative estimate**: 2-3 GB (if only Artifact Registry cleanup)
- **Aggressive estimate**: 2-4 GB (includes local cleanup)

---

## 7. SAFE DELETION CHECKLIST

### Before Deletion - VERIFY THESE ARE SAFE:

```
❌ DO NOT DELETE:
  [ ] southamerica-west1-docker.pkg.dev/.../backend-image:latest (ACTIVE in production)
  [ ] node:20-slim (REQUIRED for Dockerfile)
  [ ] Any image deployed to Cloud Run proypers25-backend

✅ SAFE TO DELETE (verify each first):
  [ ] backend-image:build9-manual (Build 9 orphaned tag)
  [ ] backend-image:manual-build9 (Build 9 orphaned tag)
  [ ] Any untagged images from Build 5, 7, 9 with old digests
  [ ] Local docker images tagged backend:* (if not in use)
  [ ] docker.io/node:20-slim (after verifying latest:latest digest)
```

---

## 8. DETAILED DELETION INSTRUCTIONS

### Option A: Clean Artifact Registry (GCP Console)

1. Go to GCP Console → Artifact Registry → backend-repo
2. Find `backend-image` repository
3. Delete specific tags:
   - `build9-manual` → Delete
   - `manual-build9` → Delete
4. Delete untagged images with creation dates < 2026-04-18

### Option B: Clean Artifact Registry (gcloud CLI)

```bash
# List all images in backend-repo
gcloud artifacts docker images list \
  southamerica-west1-docker.pkg.dev/proypers2025/backend-repo

# Delete specific tags
gcloud artifacts docker images delete \
  southamerica-west1-docker.pkg.dev/proypers2025/backend-repo/backend-image:build9-manual

gcloud artifacts docker images delete \
  southamerica-west1-docker.pkg.dev/proypers2025/backend-repo/backend-image:manual-build9

# Delete untagged images (use full digest)
gcloud artifacts docker images delete \
  southamerica-west1-docker.pkg.dev/proypers2025/backend-repo/backend-image@sha256:<old-digest>
```

### Option C: Clean Local Docker Images (if Docker is running)

```bash
# View all local images
docker images | grep -E "(backend|proypers)"

# Remove specific tags
docker rmi backend-image:build9-manual
docker rmi backend-image:manual-build9
docker rmi backend:prod
docker rmi backend:latest

# Remove dangling images
docker image prune -a

# Remove build cache (reclaim more space)
docker builder prune -a
```

---

## 9. MONITORING & PREVENTION

### Prevent Future Buildup
1. **Use consistent tagging**:
   - ✅ Only use `:latest` for production
   - ✅ Use `:build-{N}` for experimental tags (delete after testing)
   - ❌ Avoid manual tagging like `build9-manual`

2. **Enable automatic cleanup policies** (Artifact Registry):
   ```
   - Keep only last N images: 3
   - Delete images older than: 30 days
   - Exception: Keep all images tagged `:latest`
   ```

3. **In cloudbuild.yaml**, explicitly clean old images:
   ```yaml
   - name: 'gcr.io/cloud-builders/docker'
     args: ['image', 'prune', '-af']  # Clean all dangling images before build
   ```

---

## 10. RISK ASSESSMENT

### Deletion Risk Matrix

| Item | Risk | Impact | Recovery |
|------|------|--------|----------|
| `build9-manual` | 🟢 NONE | None (unused) | Not needed |
| `manual-build9` | 🟢 NONE | None (unused) | Not needed |
| Untagged artifacts | 🟢 NONE | None (cache only) | Not needed |
| `backend-image:latest` | 🔴 CRITICAL | Service down | Rebuild & redeploy (5 min) |
| `node:20-slim` | 🟡 MEDIUM | Build fails | Pull from Docker Hub (2 min) |

---

## FINAL RECOMMENDATION

### Phase 1: Immediate (Safe)
✅ Delete from Artifact Registry:
- `backend-image:build9-manual`
- `backend-image:manual-build9`
- Any untagged images with creation date < 2026-04-18

**Estimated savings**: 600-900 MB

### Phase 2: Long-term (Preventive)
✅ Implement cleanup policies:
- Enable Artifact Registry lifecycle policies
- Standardize tag naming in cloudbuild.yaml
- Add `docker image prune` step before builds

---

## APPENDIX: COMPLETE IMAGE REFERENCE

### All Images Found in Project References

| Image | Type | Location | Status |
|-------|------|----------|--------|
| `node:20-slim` | Base | Docker Hub | ✅ ACTIVE |
| `backend-image:latest` | Built | Artifact Registry | ✅ ACTIVE |
| `backend-image:build9-manual` | Built | Artifact Registry | ⚠️ ORPHANED |
| `backend-image:manual-build9` | Built | Artifact Registry | ⚠️ ORPHANED |
| `backend:prod` | Built | Local/CI (removed) | ⚠️ STALE |
| `backend:latest` | Built | Local/CI (removed) | ⚠️ STALE |
| `gcr.io/cloud-builders/docker` | Base | GCP | ✅ ACTIVE (CI tool) |
| `gcr.io/google.com/cloudsdktool/cloud-sdk` | Base | GCP | ✅ ACTIVE (CI tool) |

