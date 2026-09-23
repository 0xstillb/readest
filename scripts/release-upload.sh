#!/usr/bin/env bash
set -euo pipefail

release_tag=${1:?usage: release-upload.sh <tag> <asset>...}
shift
repository=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}
if (($# == 0)); then
  echo "::error::At least one release asset is required"
  exit 2
fi

# Validate every local artifact before removing any existing release asset.
for asset_path in "$@"; do
  if [[ ! -f "$asset_path" ]]; then
    echo "::error::Release asset does not exist: $asset_path"
    exit 1
  fi
done

release_id=$(gh api "repos/$repository/releases/tags/$release_tag" --jq '.id')
existing_assets=$(gh api "repos/$repository/releases/$release_id/assets" --paginate --jq '.[].name')
for asset_path in "$@"; do
  asset_name=$(basename -- "$asset_path")
  if grep -Fxq -- "$asset_name" <<<"$existing_assets"; then
    echo "Removing existing release asset before replacement: $asset_name"
    gh release delete-asset "$release_tag" "$asset_name" --repo "$repository" --yes
  fi
done

gh release upload "$release_tag" "$@" --repo "$repository"
