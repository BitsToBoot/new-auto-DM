# Contributing

Thanks for helping make CampaignCue better.

This project is public because the core Instagram comment-to-DM engine should be inspectable, self-hostable, and useful to builders. The hosted SaaS will monetize managed infrastructure, agency workflows, analytics, reports, support, and templates.

## Ways To Contribute

- Fix bugs.
- Improve docs.
- Add campaign templates.
- Improve tests.
- Help with production hardening.
- Build small UI improvements.

Good starting point: the [CampaignCue issue list](https://github.com/BitsToBoot/new-auto-DM/issues).

CampaignCue is maintained by Shubham Sharma and Yashwant Khatri. It is a fork of [instagram-comment-to-dm](https://github.com/im-anishraj/instagram-comment-to-dm) by Anish Raj.

## Licensing Of Contributions

CampaignCue is MIT licensed (see [LICENSE](LICENSE) and [NOTICE](NOTICE)). By opening a pull request, you agree that your contribution is licensed under the MIT License. Keep existing copyright and license notices intact, and do not submit code you are not entitled to license under MIT.

## Development Setup

```bash
npm install
docker-compose up -d
cp .env.example .env
npm run db:generate
npm run db:migrate
npm run dev
```

Run the worker in a second terminal:

```bash
npm run worker
```

## Pull Request Rules

- Create a branch from `main`.
- Use branch names like `area/short-description`.
- Do not commit directly to `main`.
- Link the GitHub issue in the PR body.
- Keep PRs focused on one issue.

Required checks:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

If a check cannot be run locally, explain why in the PR body.

## Branch Naming

Preferred examples:

- `growth/github-viral-setup`
- `hardening/production-readiness`
- `product/public-templates`
- `product/tracked-links-analytics`
- `docs/meta-app-review`

## Issue Labels

- `priority:p0`: launch blocker.
- `priority:p1`: high priority.
- `priority:p2`: important follow-up.
- `area:*`: subsystem or roadmap area.
- `type:*`: kind of work.

## Campaign Templates

Template contributions should include:

- Template name.
- Target niche.
- Suggested post/reel prompt.
- Keywords.
- DM copy.
- Compliance notes.
- Example use case.

Do not include private customer data, real tokens, or scraped content.

## Security

Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
