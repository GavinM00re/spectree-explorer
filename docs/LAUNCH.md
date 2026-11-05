# Launch notes

## Prepare

1. Serve this folder locally with `node serve.cjs` and open `http://127.0.0.1:8790/`.
2. Try the guided example, verify the final name and structure, and use Back to revise an answer.
3. Open Architecture View and Full Path; confirm the full library count is 105,328.
4. Run `node scripts/verify-release.cjs .`.

The release manifest checks byte-level completeness. Any intentional source change requires rebuilding the manifest from the research checkout with `node phase1/app/v7_map/release/build.cjs`, then rerunning validation. Do not edit binary payloads or convert their line endings.

The November 4 local browser check completed the 17-answer guided caffeine example in the packaged website, exercised Back in a manual session, and checked the mobile layout at 320 pixels. Both maps loaded the full library; keyboard actions in their inspectors focused the new heading and returned focus to Details on close. The radial tree also stayed within a 750 × 400 viewport. Reduced-motion handling was inspected in the source; it was not tested with the operating system preference enabled. These checks do not establish scientific accuracy or complete accessibility coverage.

## Publish on GitHub Pages

This directory is the prepared repository root. It includes the complete static website, a local server, a verifier, data provenance, and third-party license notices. It excludes the research environments, run outputs, workstation paths, and launcher logs.

After uploading or pushing the reviewed release to the intended repository:

1. Open repository **Settings → Pages** and select **GitHub Actions** as the source.
2. Open **Actions → Publish SpecTree → Run workflow** on the desired branch.
3. Wait for the validation and deployment steps to succeed.
4. Open the Pages URL shown by GitHub and verify the guided example and tree there.
5. Add that verified URL to the repository's About section and hackathon submission.

The workflow is manual: ordinary pushes do not deploy it. GitHub's [custom Pages guide](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) describes repository access and publishing setup. GitHub [blocks individual Git files larger than 100 MiB](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github); the release verifier checks every file against that limit. The tree binary exceeds the browser upload limit, so use Git for this complete release.

## Hackathon handoff

The launch description should explain what SpecTree does, show a working example, identify the exact Meta model or developer tool used and its actual role, and clearly label the demonstrations as simulated readings. Do not claim a Meta integration that has not been implemented or documented.

This package is prepared and verified locally. Publishing was not attempted because the current request is to finish the local repository first. Before publishing, confirm the intended GitHub repository and its access, then run the manual workflow above.

The event's [official page](https://events.cerebralvalley.ai/e/meta-ai-developer-hackathon) lists the submission deadline as November 4, 2026, at 9:00 PM Eastern. Check the submission portal for the applicable track requirements and final artifacts.
