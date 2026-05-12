# GitHub PR Files/Lines Count

A userscript that adds changed file counts and changed line counts to GitHub pull request pages and pull request list views.

## Features

- Updates the **Files changed** tab on individual pull requests to show:
  - files changed
  - total changed lines
- Adds file/line stats to pull request list rows on pages like:
  - `/pulls/inbox`
  - `/pulls/reviews`
  - other `/pulls/*` views
- Supports GitHub single-page-app navigation, so stats keep updating as you move between views without a full reload
- Uses your existing authenticated GitHub browser session to fetch PR file-change pages

## Install

First install a userscript manager:

- [Tampermonkey](https://www.tampermonkey.net/)
- [Violentmonkey](https://violentmonkey.github.io/)

Then install the script:

**[Install github-pr-files-lines-count.user.js](https://raw.githubusercontent.com/bxthings/github-pr-files-lines-count/main/github-pr-files-lines-count.user.js)**

## What it looks like

On individual pull requests, the **Files changed** tab is updated to show file and line counts.

On pull request list pages, each row gets additional stats showing:

- files changed
- total changed lines

When GitHub provides a metadata section for the row, the script inserts the stats there. Otherwise, it falls back to an inline placement next to the PR title area.

## Supported pages

- `https://github.com/*/*/pull/*`
- `https://github.com/pulls/*`

## Notes

- This script depends on GitHub’s DOM structure and may need updates if GitHub changes their UI.
- It fetches pull request file-change pages using your current logged-in GitHub session in the browser.
- To avoid excessive rerenders on GitHub’s SPA navigation, the script throttles repeat runs on the same page.

## Privacy / behavior

This script:

- runs locally in your browser through your userscript manager
- makes requests to GitHub using your existing browser session
- does not send data to any third-party service

## Development

The script is a single userscript file:

- `github-pr-files-lines-count.user.js`

If you want to modify it locally, edit the script and reinstall or update it in your userscript manager.

## Troubleshooting

If the script stops working:

1. Refresh the page
2. Confirm the userscript is enabled in Tampermonkey or Violentmonkey
3. Check whether GitHub changed the page structure
4. Open an issue with:
   - the page URL pattern
   - what you expected to see
   - what happened instead
   - console errors, if any

## Support

If something breaks or you have an idea for improvement, open an issue here:

https://github.com/bxthings/github-pr-files-lines-count/issues

## License

MIT
