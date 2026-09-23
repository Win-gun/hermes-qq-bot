#!/bin/zsh
set -euo pipefail

project_dir="${0:A:h:h}"
build_dir="${HERMES_QQ_BUILD_OUT:-out}"
app_path="$project_dir/$build_dir/Hermes QQ Bot-darwin-arm64/Hermes QQ Bot.app"
output_dir="$project_dir/$build_dir/make/dmg/arm64"
output_path="$output_dir/Hermes-QQ-Bot-1.0.0-beta.4-arm64.dmg"
stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/hermesqq-dmg.XXXXXX")"

cleanup() {
  rm -rf "$stage_dir"
}
trap cleanup EXIT

if [[ ! -d "$app_path" ]]; then
  print -u2 -- "Packaged app not found: $app_path"
  exit 1
fi

mkdir -p "$output_dir"
cp -R "$app_path" "$stage_dir/Hermes QQ Bot.app"
ln -s /Applications "$stage_dir/Applications"
rm -f "$output_path"
hdiutil create -volname "Hermes QQ Bot" -srcfolder "$stage_dir" -ov -format ULFO "$output_path"
print -r -- "$output_path"
