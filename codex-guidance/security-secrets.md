# Security and secret handling

## Rules

- Never commit real secrets to the repository.
- Never commit `.env` files with real values.
- Never hardcode API keys, tokens, passwords, private keys, certificates, DSNs, or cloud credentials.
- Store secrets in environment variables or a secret manager.
- Commit only templates such as `.env.example` or `.env.template` with placeholder values.
- If a file contains secrets, it must stay untracked.
- Before commit and before push, review staged changes for secrets.
- If a diff contains a secret, stop and remove it before committing.
- If a secret was exposed, rotate or revoke it immediately and remove it from the branch and repository history.

## Required ignore rules

The repository must ignore local secret files.

Minimum `.gitignore` rules:

```gitignore
.env
.env.*
!.env.example
!.env.template
!.env.sample

*.pem
*.key
*.crt
*.p12
*.pfx

secrets.*
secret.*
credentials.*
config.local.*
*.local

terraform.tfstate
terraform.tfstate.*
*.tfvars
```
