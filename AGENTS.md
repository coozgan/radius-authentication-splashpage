# AGENTS.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Architecture & System Overview

This repository implements a RADIUS authentication system with Meraki splash page integration, an event-driven AWS tracking backend, and a Cloudflare-hosted Next.js dashboard. 

The system is split into three main components:

1. **Core RADIUS Server (Root Directory)**
   - **Tech Stack**: Node.js, Express, `node-radius`.
   - **File**: `server.js` is the main entry point.
   - **Function**: Proxies auth requests from Meraki splash pages to a RADIUS server. Checks for a specific `Filter-ID` before granting network access.
   - **Meraki Integration**: Automatically renames endpoint devices asynchronously via the Meraki API on successful auth (format: `username.last4mac`). Documented in `MERAKI_DEVICE_RENAME.md`.
   - **AWS Integration**: Publishes auth events to an SQS queue via `@aws-sdk/client-sqs`.
   - **Deployment**: Containerized via `Dockerfile` and designed for AWS ECS (Fargate) execution using `task-definition.json`. 

2. **AWS Tracking Infrastructure (`/infrastructure`)**
   - **Tech Stack**: Terraform, AWS Lambda, SQS, DynamoDB.
   - **Function**: Manages the backend tracking components.
   - **Lambda Process (`/infrastructure/lambda-src/index.js`)**: Consumes events from the SQS queue pushed by the Express server. Upserts client connection records in DynamoDB (using MAC Address as the Primary Key) to track connection timestamps without automatically deleting old records.

3. **Dashboard (`/dashboard`)**
   - **Tech Stack**: Next.js 16 (React 19), Tailwind CSS v4, OpenNext.
   - **Function**: Frontend UI for the system.
   - **Deployment**: Deployed to Cloudflare Workers using `@opennextjs/cloudflare` and `wrangler`.

## Common Commands & Workflows

### RADIUS Server (Root)
- **Start Dev Server**: `npm run dev` (Runs with `nodemon` on port 3000)
- **Test Auth Endpoint**: `curl http://localhost:3000/test-splash`
- **Docker Build**: `docker build -t meraki-radius-auth .`
- *Note: Configuration relies entirely on environment variables (see `README.md` and `.env.example`).*

### Dashboard (`/dashboard`)
- **Start Dev Server**: `npm run dev` (Runs on port 3001 to avoid conflicts with the RADIUS server)
- **Generate Cloudflare Types**: `npm run cf-typegen`
- **Build & Preview**: `npm run preview`
- **Deploy to Cloudflare**: `npm run deploy` (Runs OpenNext build + Wrangler deploy)

### Infrastructure (`/infrastructure`)
- **Initialize**: `terraform init`
- **Plan Changes**: `terraform plan` (or `terraform plan:*` as permitted in `.claude/settings.local.json`)
- **Apply Changes**: `terraform apply`

## Development Notes
- **Testing**: There is no standard automated unit test suite configured for the core business logic. Testing should be done manually against the `/test-splash` Express endpoint.
- **Code Maintenance**: The `/scripts` directory contains utilities like `cleanup-wrong-imports.js` and `import-clients.js` for codebase maintenance.
