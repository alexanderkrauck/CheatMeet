#!/usr/bin/env bash
set -euo pipefail
: "${GCP_PROJECT_ID:?}" "${GCP_REGION:?}" "${CLOUD_RUN_SERVICE:?}" "${DEPLOY_IMAGE:?}"
: "${GITHUB_SHA:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}" "${GITHUB_REPOSITORY:?}"

# A queued, older successful run must never replace a newer main deployment.
latest=$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main" --jq .object.sha)
if [[ "$latest" != "$GITHUB_SHA" ]]; then
  echo "Skipping superseded main commit $GITHUB_SHA."
  exit 0
fi
previous=$(gcloud run services describe "$CLOUD_RUN_SERVICE" --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --format=json | python3 -c 'import json,sys; s=json.load(sys.stdin); print(",".join(t["revisionName"]+"="+str(t["percent"]) for t in s["status"]["traffic"] if t.get("percent",0)>0))')
suffix="gh-${GITHUB_SHA:0:12}-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"

# Construct a no-traffic revision atomically: AI Studio's source-overlay
# annotation must be removed together with its base image and runtime class.
# The transient service spec contains existing env values; never log or upload it.
revision="$CLOUD_RUN_SERVICE-$suffix"
umask 077
spec=$(mktemp)
trap 'rm -f "$spec"' EXIT
gcloud run services describe "$CLOUD_RUN_SERVICE" --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --format=json |
  python3 scripts/prepare-cloud-run.py "$DEPLOY_IMAGE" "$revision" > "$spec"
gcloud run services replace "$spec" --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --quiet
candidate=$(gcloud run services describe "$CLOUD_RUN_SERVICE" --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --format=json | python3 -c 'import json,sys; s=json.load(sys.stdin); print(next(t["url"] for t in s["status"]["traffic"] if t.get("tag")=="candidate"))')
node scripts/smoke-deployment.mjs "$candidate"

latest=$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main" --jq .object.sha)
if [[ "$latest" != "$GITHUB_SHA" ]]; then
  echo "Candidate passed, but a newer main commit exists. Leaving live traffic unchanged."
  exit 0
fi
gcloud run services update-traffic "$CLOUD_RUN_SERVICE" --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --to-revisions="$revision=100" --quiet
url=$(gcloud run services describe "$CLOUD_RUN_SERVICE" --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --format='value(status.url)')
if ! node scripts/smoke-deployment.mjs "$url"; then
  echo "Live smoke failed; restoring $previous."
  gcloud run services update-traffic "$CLOUD_RUN_SERVICE" --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --to-revisions="$previous" --quiet
  exit 1
fi
{
  echo "### Production deployed"
  echo "- Commit: $GITHUB_SHA"
  echo "- Revision: $revision"
  echo "- Previous revision: $previous"
  echo "- URL: $url"
} >> "$GITHUB_STEP_SUMMARY"
