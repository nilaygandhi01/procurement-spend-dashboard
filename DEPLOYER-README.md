# Deployer K8s PaaS

## About
Welcome to your repository which got created by requesting an instance of the
**Deployer K8s PaaS** service in Platform McKinsey (PMcK).<br/>
This repository comes with pre-defined GitHub Action (GHA) workflows that enable you
to deploy your application to a shared Kubernetes (K8s) cluster as well
as deploying infrastructure in a shared AWS account (eg. S3, RDS).<br/>
It also includes **Cursor AI skills** that orchestrate the full development lifecycle —
from scaffolding a new application through deployment and day-2 operations — using
natural-language instructions.<br/>
Read more about the [repository structure](#repository-structure) and
[building your application](#building-your-application) below.

## Documentation
Documentation about the **Deployer K8s PaaS** service can be found in [Platform McKinsey Knowledge Base](https://platform.mckinsey.com/knowledge-base/service-guide/852265408/deployer-k8s-paas).<br/>
Below are some articles to start with:
* [Deployer-K8s-PaaS architecture diagram](https://platform.mckinsey.com/knowledge-base/service-guide/1029898526/deployer-k8s-paas-application-architecture)
* [Getting Started guide](https://platform.mckinsey.com/knowledge-base/service-guide/1054572739/getting-started)

Please also check our [HowTo articles](https://platform.mckinsey.com/knowledge-base/service-guide/1144328085/how-tos) that address typical scenarios like creating/configuring/consuming S3 buckets and databases etc.

## Repository structure
Your repository contains the following key directories:

* **`.github/workflows/`** - Managed CD workflows that enable application & infrastructure deployment
* **`.cursor/skills/deployer-skills/`** - Cursor AI skills synced at runtime (auto-populated on first use)
* **`deployer-apps/<instance-name>/`** - Application-specific files:
  * `src/` - Your application source code
  * `<environment>-<region>/manifests/` - Helm charts and Kubernetes manifests for deploying your application
  * `<environment>-<region>/iac/` - Terraform infrastructure configuration files for AWS resources (S3, RDS, etc.)

## GitHub Action workflows
Your repository includes managed GHA workflows that enable you to deploy and manage your application with minimum effort.<br/>
These workflows are managed centrally and should not be edited by the customer (all changes to these workflow files may be overwritten at any time).<br/>

### Deployment Workflows
* **[instance name]-[environment]-Deploy All**: Executes all deployment workflows (sync application, update secrets, and deploy infrastructure)
* **[instance name]-[environment]-Deploy infra**: Deploys AWS infrastructure as configured in `./deployer-apps/<instance-name>/<environment>-<region>/iac/`
* **[instance name]-[environment]-Deploy secrets**: Creates K8s secrets based on GitHub repository secrets. See [documentation](https://platform.mckinsey.com/knowledge-base/service-guide/1043824755/how-to-use-secrets-in-your-application)
* **[instance name]-[environment]-Sync argo app**: Force synchronizes your application manifests from `./deployer-apps/<instance-name>/<environment>-<region>/manifests/` to your K8s namespace

### Additional Workflows
* **Deployer Promote Environment**: Promotes configuration changes between environments (dev → stg → prod) by creating a Pull Request
* **Security scan**: Automatically scans code for security vulnerabilities on pull requests and manual triggers


## Building Your Application

This repository uses **Cursor AI skills** to guide you through the full application development lifecycle. Skills are organized into three phases, each triggered by natural-language instructions in Cursor.

### Phase 1 — Build

Start here if you are building something new or assessing whether an existing app can be deployed.

| What You Want | What To Say in Cursor |
|---------------|----------------------|
| Start a new application (guided) | "I want to build an app" |
| Build a simple website or SPA | "Simple web app" |
| Build a dashboard over Excel/CSV data | "Create data dashboard" |
| Assess an existing codebase | "Assess my app" |
| Import a v0.dev project | "Download v0 project" |
| Import a Lovable app | "Download lovable app" |

### Phase 2 — Deploy

Once your application is ready, deploy it to Kubernetes with a single instruction.

| What You Want | What To Say in Cursor |
|---------------|----------------------|
| Full end-to-end deployment | "Deploy application" |
| Containerize only | "Dockerize application" |
| Move secrets to Vault | "Move sensitive variables into secrets" |
| Upload data files to S3 | "Upload data to S3" |

### Phase 3 — Day-2 Operations

After your app is running, use skills for ongoing maintenance and feature additions.

| What You Want | What To Say in Cursor |
|---------------|----------------------|
| Diagnose why app isn't loading | "My app isn't loading" or "Troubleshoot" |
| Add a PostgreSQL or MySQL database | "Add database" or "Add postgres" |
| Add an S3 bucket | "Add S3" or "Create bucket" |
| Add an SQS queue | "Add SQS" |
| Manage user access | "Add user@mckinsey.com to my application" |

### How Skills Work

Skills are fetched automatically from the [Code Beyond AI DLC](https://github.com/McK-Internal/code-beyond-ai-dlc) repository and installed under `.cursor/skills/deployer-skills/` the first time you use them. The only prerequisite is the [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated.

For a complete reference of all available skills, trigger phrases, and detailed descriptions of what each skill does, see [DEPLOYMENT.md](./DEPLOYMENT.md).

---

## Application URL

Your application is accessible at `https://<subdomain_prefix>.<cloudflare_zone>`, where:

* `<subdomain_prefix>` is the subdomain prefix you chose (or were assigned) during instance creation in Platform McKinsey. You can view or change it in the PMcK instance details under `App Name prefix`. This value is stored in `values.yaml` as `subdomainPrefix` and as a Kubernetes namespace annotation (`lrah.mckinsey.com/subdomain-prefix`).
* `<cloudflare_zone>` is the Cloudflare zone used for instance URLs. It is derived from the instance's `used_for` setting:
  - `sbx` -> `sbx.apps.mckinsey.com`
  - `non_prod` -> `npn.apps.mckinsey.com`
  - `prod` -> `apps.mckinsey.com`

The DNS CNAME record and Cloudflare Access protection for this URL are created automatically by the control plane during instance provisioning. If you change the subdomain prefix in PMcK, the control plane will automatically update the DNS record, namespace annotation, and `values.yaml`.

## Access application logs in Dynatrace
Applications running on Deployer K8s PaaS are sending their logs to the Firm’s Observability system (Dynatrace). In order to grant users access to these logs, Dynatrace is leveraging the ProductID which is assigned to a specific application.

Check the [HowTo articles](https://platform.mckinsey.com/knowledge-base/service-guide/1170245292/how-to-access-application-logs-in-dynatrace-for-applications-hosted-on-deployer-k8s-paas) to discover how to
get access on application logs in Dynatrace.

## Setup local development environment

In order to start developing your application locally, you may want to install
some standard tooling (if not done already).

### Install Docker
Install [Docker for Business](https://mckinsey.service-now.com/ghd?id=mck_app_cat_item&table=pc_software_cat_item&sys_id=157a289187c6c1d0011e52c83cbb35ef) and enable the Kubernetes option.

As an alternative to Docker, you may want to install [Podman Desktop](https://platform.mckinsey.com/team/no-team/create-service/d4a3647c-10ee-44da-848d-b7a52610f633) instead.

### Install Kubernetes tooling
```bash
brew install helm kubectl
```

### Configure pulling images
To pull images from OneFirm Artifactory ([JFrog](https://mckinsey.jfrog.io/ui/login/)), you need to create a secret in your local K8s cluster. The secret name must match the `imagePullSecrets` entry in `manifests/values.yaml` (`jfrog-<environment-id>-secret`):
```bash
# Replace <environment-id> with your UserEnvironmentID (same value used in values.yaml)
kubectl create secret docker-registry jfrog-<environment-id>-secret -n <namespace> \
  --docker-server=mckinsey-<productname>-docker.jfrog.io \
  --docker-username=<Firstname_Lastname@mckinsey.com> \
  --docker-password=<API-Token> \
  --docker-email=<Firstname_Lastname@mckinsey.com>
```

### Install Helm chart
In order to deploy your application to your locally running K8s cluster, execute the below command:
```bash
# Replace <instance-name>, <environment>, and <region> with your actual values
helm install app ./deployer-apps/<instance-name>/<environment>-<region>/manifests
```

## Pre-commit
Pre-commit hooks run a set of actions (defined in a [config file](./.pre-commit-config.yaml))
on all new/changed files that are part of a commit.<br/>
In case any of the hooks detected a failure, it will cancel the commit and prevent
you from pushing to the remote repository.<br/>
Using pre-commit hooks is a best practice and thus recommended to use.

### Install pre-commit binary
```bash
brew install pre-commit
```

### Install pre-commit hooks
After you cloned the repository, you have to run the below command in the repository root directory to install/activate the pre-commit hooks
configured in the [config file](./.pre-commit-config.yaml).
```bash
pre-commit install
```

**NOTE:** 
* The pre-commit [config file](./.pre-commit-config.yaml) that is deployed along with this repository requires some dependencies to be installed for the pre-commit hooks to work (see below).
* The Terraform pre-commit hooks are disabled by default, as they require you to have access to the Firm's Terraform Enterprise (TFE) solution. If you have access to TFE and would like to leverage the Terraform pre-commit hooks, simply uncomment the respective section in the [config file](./.pre-commit-config.yaml).

### Install GitGuardian
```bash
brew install ggshield

# to authenticate:
ggshield auth login
```

### Install Terraform tools
**Note:** The Terraform pre-commit hooks are disabled by default, as they require you to have access to the Firm's Terraform Enterprise (TFE) solution. If you have access to TFE and would like to leverage the Terraform pre-commit hooks, simply uncomment the respective section in the [config file](./.pre-commit-config.yaml).

```bash
brew install tfenv tflint terraform_docs

# to select Terraform version:
tfenv use 1.9.3

# to authenticate to Terraform Enterprise:
terraform login terraform.mckinsey.cloud
```
