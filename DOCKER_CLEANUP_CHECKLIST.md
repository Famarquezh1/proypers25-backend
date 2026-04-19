# Docker Images - QUICK CLEANUP REFERENCE

## Current Status Summary
- **System**: Windows (local Docker not running)
- **Production Images**: Stored in GCP Artifact Registry (southamerica-west1)
- **Active Deployment**: Cloud Run with `backend-image:latest`
- **Last Build**: Build 11 (2026-04-19)

---

## ALL DOCKER IMAGES FOUND

### ✅ ACTIVE IMAGES (IN USE - DO NOT DELETE)

```
Name:    backend-image:latest
Type:    Production
Location: southamerica-west1-docker.pkg.dev/proypers2025/backend-repo/
Digest:  sha256:821f4183c9db4f6984cb4e1370045cf51ca416cb68cc5d95025887b79707c087
Size:    ~300 MB
Status:  ✅ DEPLOYED TO CLOUD RUN (proypers25-backend-00361-h7s)
Built:   2026-04-18 19:09:14 UTC
Action:  🔴 DO NOT DELETE - PRODUCTION IMAGE
```

```
Name:    node:20-slim
Type:    Base Image
Location: Docker Hub
Size:    ~150 MB (base), ~300 MB with Python 3.9 added
Status:  ✅ REQUIRED FOR BUILDS
Purpose: Node.js 20 runtime + Python 3.9 for TensorFlow/ML features
Action:  🔴 DO NOT DELETE - REQUIRED DEPENDENCY
```

---

### ⚠️ ORPHANED/UNUSED IMAGES (SAFE TO DELETE)

```
Name:    backend-image:build9-manual
Type:    Artifact
Location: southamerica-west1-docker.pkg.dev/proypers2025/backend-repo/
Size:    ~300 MB
Created: ~2026-04-15
Status:  ⚠️ ORPHANED - Build 9 manual override attempt
Used:    Never deployed to production
Action:  ✅ SAFE TO DELETE
```

```
Name:    backend-image:manual-build9
Type:    Artifact
Location: southamerica-west1-docker.pkg.dev/proypers2025/backend-repo/
Size:    ~300 MB
Created: ~2026-04-15
Status:  ⚠️ ORPHANED - Alternate tag from Build 9
Used:    Never deployed to production
Action:  ✅ SAFE TO DELETE
```

```
Name:    [Untagged artifacts from failed builds]
Type:    Build cache/intermediate images
Location: southamerica-west1-docker.pkg.dev/proypers2025/backend-repo/
Size:    ~300 MB each (estimated 3-5 images)
Created: ~2026-04-05 to 2026-04-15 (Build 5, 7, 9 attempts)
Status:  ⚠️ ORPHANED - No reference tags
Used:    Never
Action:  ✅ SAFE TO DELETE
```

---

## DELETION CANDIDATES - PRIORITY LIST

### 🟡 High Priority (SAFE & HIGH IMPACT)
| Image | Size | Location | Command |
|-------|------|----------|---------|
| `backend-image:build9-manual` | 300 MB | Artifact Registry | `gcloud artifacts docker images delete southamerica-west1-docker.pkg.dev/proypers2025/backend-repo/backend-image:build9-manual` |
| `backend-image:manual-build9` | 300 MB | Artifact Registry | `gcloud artifacts docker images delete southamerica-west1-docker.pkg.dev/proypers2025/backend-repo/backend-image:manual-build9` |

### 🟠 Medium Priority (Requires GCP Console)
| Description | Size | Count | Action |
|-------------|------|-------|--------|
| Untagged images (failed builds) | 300 MB | ~3-5 | View in GCP Console → Artifact Registry → Select by digest → Delete |

### 🟢 Low Priority (Development-only)
| Image | Size | Location | Command |
|-------|------|----------|---------|
| `backend:prod` | 300 MB | Local (if exists) | `docker rmi backend:prod` |
| `backend:latest` | 300 MB | Local (if exists) | `docker rmi backend:latest` |

---

## SPACE RECOVERY ESTIMATE

| Cleanup Scope | Images Count | Size Freed | Effort |
|---------------|--------------|-----------|--------|
| Manual build tags only | 2 | ~600 MB | 🟢 2 min |
| + Untagged artifacts | 5-7 | ~1.5-2 GB | 🟡 5 min |
| + Local images | 9-11 | ~2-3 GB | 🟠 10 min |

---

## SAFE DELETION COMMANDS

### Delete from Artifact Registry (via gcloud)

```bash
# List all images first (verify before deletion)
gcloud artifacts docker images list \
  southamerica-west1-docker.pkg.dev/proypers2025/backend-repo

# Delete specific orphaned tags
gcloud artifacts docker images delete \
  southamerica-west1-docker.pkg.dev/proypers2025/backend-repo/backend-image:build9-manual

gcloud artifacts docker images delete \
  southamerica-west1-docker.pkg.dev/proypers2025/backend-repo/backend-image:manual-build9

# To delete untagged images (get digest from console first)
gcloud artifacts docker images delete \
  southamerica-west1-docker.pkg.dev/proypers2025/backend-repo/backend-image@sha256:XXXXX
```

### Delete Local Images (if Docker running)

```bash
# View all local images with "proypers" or "backend"
docker images | grep -E "backend|proypers"

# Remove specific local tags
docker rmi backend-image:build9-manual
docker rmi backend-image:manual-build9
docker rmi backend:prod
docker rmi backend:latest

# Prune all dangling/unused images
docker image prune -a --force
```

---

## BEFORE YOU DELETE - SAFETY CHECKLIST

```
✅ Verify before deletion:

[ ] Confirm backend-image:latest is still deployed to Cloud Run
    → gcloud run services describe proypers25-backend --region southamerica-west1

[ ] Confirm current digest in production
    → Check FINAL_SYSTEM_CERTIFICATION.md (should be: sha256:821f4183c9db...)

[ ] Take note of any build IDs using these images
    → Confirm Build 5, 7, 9 are NOT in current deployment chain

[ ] If deleting untagged images: Get digest list first
    → gcloud artifacts docker images list \
      southamerica-west1-docker.pkg.dev/proypers2025/backend-repo --include-tags

❌ DO NOT DELETE:
  - backend-image:latest (PRODUCTION)
  - node:20-slim (REQUIRED FOR BUILDS)
  - Any image currently deployed to Cloud Run
```

---

## SUMMARY TABLE

| Image | Status | Size | Delete? |
|-------|--------|------|---------|
| **backend-image:latest** | ✅ Production | 300MB | 🔴 NO |
| **node:20-slim** | ✅ Required | 150MB | 🔴 NO |
| backend-image:build9-manual | ⚠️ Orphaned | 300MB | ✅ YES |
| backend-image:manual-build9 | ⚠️ Orphaned | 300MB | ✅ YES |
| [Untagged from Build 5,7,9] | ⚠️ Unused cache | 300MB each | ✅ YES |
| backend:prod (local) | ⚠️ Development | 300MB | ✅ YES |
| backend:latest (local) | ⚠️ Development | 300MB | ✅ YES |

**Total Reclaimable Space**: 1.5-3 GB (depending on scope)  
**Risk Level**: 🟢 LOW (all candidates are unused or development-only)

