# WorkSphere

> A production-ready Employee Management Platform built with the MERN stack, microservices, Docker, CI/CD, Terraform, and AWS.

WorkSphere is a full-stack employee management platform designed to demonstrate production-oriented software engineering practices rather than only basic CRUD functionality. The project combines a modern React frontend with independently deployable Node.js/Express microservices, MongoDB persistence, secure authentication and authorization, containerized local development, automated CI/CD, observability, and AWS deployment.

---

## Run the implemented application

The current implementation is a React app in `frontend/` and a modular Express API in
`backend/`. The microservice layout later in this document remains a roadmap.
Registration, login, session refresh, logout, protected dashboard, and role-scoped
employee CRUD are implemented.

```sh
cd backend
npm ci
cp .env.example .env
# Set JWT_ACCESS_SECRET to a random secret (at least 32 characters).
# Generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
npm start
```

Start MongoDB locally on port 27017, or set `MONGO_URI` in `backend/.env`.
In another terminal:

```sh
cd frontend
npm ci
cp .env.example .env
npm start
```

Open http://localhost:3000. Alternatively, after configuring `backend/.env`, run
`docker compose up --build` from the repository root to start MongoDB, API, and web.
The compose configuration is for local development.

### Current source layout

```text
frontend/src/
  api/                 shared HTTP client and session refresh
  features/auth/       forms and authentication state
  features/dashboard/  account overview
  features/employees/  scoped employee directory and editing
  layouts/             authenticated navigation
  styles/              responsive application styles
backend/src/
  config/              environment validation
  middleware/          authentication and authorization
  migrations/          explicit MongoDB data migrations
  models/              Account, Session, Employee
  routes/              versioned auth and employee endpoints
  services/            validation and session lifecycle
backend/tests/         API integration tests with ephemeral MongoDB
backend/scripts/       standalone operational commands
```

### Accounts and permissions

Public registration always creates an `EMPLOYEE`; clients cannot select a role.
Registration does not create a session. It redirects to login with a success toast
and the email prefilled; users must sign in before accessing the dashboard.
Employees see only directory records matching their email. HR managers can read,
create, and edit employee records; admins can also delete them. Registration does
not automatically create an employee record. The existing `users` MongoDB
collection remains the employee directory, while `accounts` stores credentials.
Existing directory entries are **not** login accounts: register a new account.

Provision the first administrator by registering normally, then using `mongosh`
against the configured database:

```js
db.accounts.updateOne({ email: "your-normalized-email@example.com" }, { $set: { role: "ADMIN" } })
```

Reload the page after a role change. There is no public role-management endpoint.

### Migrating existing profile names

Accounts and employees use `firstName` and `lastName`. Existing lowercase records
and cached clients remain supported during the transition. Run the read-only audit
from `backend/` with `npm run migrate:names -- --dry-run`, then follow the
[name migration guide](docs/name-migration.md) for deployment order, repeatable
backfill, cleanup, and rollback. Deploy the API before the frontend and retire old
API writers before applying the migration.

### Employee numbers

WorkSphere generates `employeeNumber` on creation, starting at `EMP-000001` in a
new database. The number is unique and immutable. Omit it from POST and PATCH
requests; supplying it returns a validation error. The employee form displays it
read-only, and employee responses, search, and sorting include it.

Existing numbers are preserved. To assign numbers to older records without one,
run `npm run migrate:employee-numbers -- --dry-run` from `backend/`, then follow
the [employee number rollout guide](docs/employee-numbers.md). The persistent
MongoDB counter handles concurrent creates and never reuses deleted numbers.
Failed creates can leave gaps in the sequence.

### Manager relationships

Employee create and update requests validate that `managerId` points to an
existing employee who is active or on leave. Self-management and reporting cycles
are rejected. Omit `managerId` to retain the current manager on PATCH; send
`managerId: null` to explicitly clear it.

Deleting a manager or setting their status to `INACTIVE` or `TERMINATED` returns
`409 MANAGER_HAS_DIRECT_REPORTS` while any employee still references them,
including inactive or terminated direct reports. HR or an admin must reassign
each report or explicitly clear its manager first. See the
[manager relationship policy](docs/manager-relationships.md) for API errors and
deployment scope.

### Session security and deployment

Passwords use bcrypt cost 12 with a 12-character minimum and 72-byte maximum.
Access JWTs expire after 15 minutes. Random refresh tokens expire after seven days,
are hashed in MongoDB, and rotate on use. Logout revokes the session immediately.
Tokens use HttpOnly, SameSite=Strict cookies and are never stored in localStorage.
Every mutation requires an exact `Origin` matching `CLIENT_ORIGIN`; scripts calling
these APIs must supply that header too. Login and registration share an IP rate
limit. Old `/auth/inventory` endpoints have been removed.

Production must use HTTPS, `NODE_ENV=production` (Secure cookies), a strong secret,
and web/API hosts on the same site. `REACT_APP_API_URL` includes `/api/v1` and is a
build-time setting. Configure proxy trust only for your known deployment topology;
the default deliberately trusts no forwarding headers. The in-memory rate limiter
is suitable for one API process; use a shared limiter store before scaling replicas.
Email verification, password recovery, and MFA are not implemented yet.

### Verify

```sh
cd backend && npm test
cd ../frontend && CI=true npm test -- --watchAll=false --runInBand
npm run build
```

Backend tests start an isolated MongoDB process with `mongodb-memory-server`; the
first run downloads a MongoDB binary. They never touch your application database.

---

## Table of Contents

- [Overview](#overview)
- [Why WorkSphere?](#why-worksphere)
- [Features](#features)
- [Architecture](#architecture)
- [Microservices](#microservices)
- [Technology Stack](#technology-stack)
- [Repository Structure](#repository-structure)
- [Domain Model](#domain-model)
- [API Design](#api-design)
- [Authentication and Authorization](#authentication-and-authorization)
- [Local Development](#local-development)
- [Docker](#docker)
- [Testing](#testing)
- [API Documentation](#api-documentation)
- [CI/CD](#cicd)
- [AWS Deployment Architecture](#aws-deployment-architecture)
- [Infrastructure as Code](#infrastructure-as-code)
- [Observability](#observability)
- [Security](#security)
- [Environment Variables](#environment-variables)
- [Development Roadmap](#development-roadmap)
- [Engineering Decisions](#engineering-decisions)
- [Future Improvements](#future-improvements)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

WorkSphere provides a centralized platform for managing employees, organizational information, access control, and administrative activity.

The application is being refactored from an existing MERN CRUD application into a portfolio-ready distributed system with a clear separation of responsibilities between services.

The goal is to demonstrate practical experience with:

- Full-stack application development
- REST API design
- Microservice architecture
- Authentication and role-based authorization
- MongoDB data modeling
- Docker and containerized development
- Automated testing
- CI/CD pipelines
- AWS cloud architecture
- Infrastructure as Code with Terraform
- Logging, monitoring, and health checks
- Production-oriented security practices

---

## Why WorkSphere?

Many portfolio employee-management applications stop at CRUD operations. WorkSphere intentionally goes further.

The project is designed to answer engineering questions such as:

- How should authentication be separated from business-domain services?
- How can APIs enforce role-based permissions?
- How should independently deployable services own their data?
- How can a React application communicate with multiple backend services without coupling itself to their locations?
- How can services be containerized and tested consistently?
- How can deployments be automated?
- How should secrets and configuration be handled across environments?
- How can a distributed application be monitored in production?
- How can infrastructure be reproduced reliably?

The result is a project that can be discussed from frontend, backend, DevOps, cloud, and system-design perspectives.

---

## Features

### Employee Management

- Create employees
- View employee profiles
- Update employee information
- Delete or deactivate employees
- Search employees
- Filter employees
- Sort employee records
- Paginated employee directory
- Department assignment
- Employment status management
- Job-title management
- Manager relationships
- Employee hire-date tracking

### Authentication

- User registration
- Secure login
- Password hashing
- JWT access tokens
- Refresh tokens
- Logout
- Protected API routes
- Current-user endpoint
- Token validation

### Authorization

Planned application roles:

| Role | Description |
| --- | --- |
| `ADMIN` | Full administrative access |
| `HR_MANAGER` | Manage employees and organizational information |
| `EMPLOYEE` | Read permitted employee/profile information |

Authorization is enforced by the backend rather than relying only on frontend route protection.

### Dashboard

The administrative dashboard will provide information such as:

- Total employees
- Active employees
- Employees by department
- Recent hires
- Employment-status distribution
- Recent administrative activity

### Audit Trail

Important administrative actions can be recorded, including:

- Employee created
- Employee updated
- Employee deleted/deactivated
- Role changed
- Authentication/security events

Audit records identify the actor, action, target resource, timestamp, and relevant metadata.

---

## Architecture

WorkSphere follows a microservice-oriented architecture while deliberately keeping the initial number of services small.

```text
                         Internet
                            |
                            v
                    +---------------+
                    |  CloudFront   |
                    +-------+-------+
                            |
                            v
                    +---------------+
                    | React Web App |
                    |    Amazon S3  |
                    +-------+-------+
                            |
                          HTTPS
                            |
                            v
                  +-------------------+
                  | Application Load  |
                  | Balancer / Gateway|
                  +---------+---------+
                            |
             +--------------+--------------+
             |              |              |
             v              v              v
      +-------------+ +-------------+ +-------------+
      | Auth Service| |Employee Svc | | Audit Svc   |
      | Node/Express| |Node/Express | |Node/Express |
      +------+------+ +------+------+ +------+------+
             |              |              |
             v              v              v
      +-------------+ +-------------+ +-------------+
      |   Auth DB   | | Employee DB | |  Audit DB   |
      |   MongoDB   | |   MongoDB   | |   MongoDB   |
      +-------------+ +-------------+ +-------------+
```

### Architectural Principles

1. Each service has a focused responsibility.
2. Services are independently deployable.
3. Business logic stays outside route handlers.
4. Each service owns its data.
5. The frontend communicates through a single API entry point.
6. Configuration is environment-specific.
7. Infrastructure is reproducible through code.
8. Security is enforced server-side.
9. Services expose health endpoints for operational visibility.
10. Architecture complexity is introduced only when it provides a clear engineering benefit.

---

## Microservices

### Auth Service

Responsible for identity and access management.

Responsibilities include:

- User registration
- Authentication
- Password hashing
- Access-token creation
- Refresh-token lifecycle
- Logout
- User roles
- Authorization information
- Current authenticated user

Example routes:

```text
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/refresh
POST /api/v1/auth/logout
GET  /api/v1/auth/me
```

---

### Employee Service

Owns the employee-management domain.

Responsibilities include:

- Employee CRUD operations
- Employee search
- Filtering
- Sorting
- Pagination
- Department information
- Employment status
- Employee-manager relationships

Example routes:

```text
GET    /api/v1/employees
POST   /api/v1/employees
GET    /api/v1/employees/:id
PATCH  /api/v1/employees/:id
DELETE /api/v1/employees/:id
```

Example query:

```text
GET /api/v1/employees?page=1&limit=20&department=Engineering&status=ACTIVE&sort=lastName
```

---

### Audit Service

Stores important administrative activity.

Responsibilities include:

- Recording employee changes
- Recording security-relevant events
- Providing authorized audit-history queries
- Maintaining an append-oriented activity history

Example routes:

```text
GET /api/v1/audit
GET /api/v1/audit/:id
```

A later version can use asynchronous events so domain services publish events without waiting for the Audit Service.

---

### API Gateway

Provides a single entry point for frontend API traffic.

Responsibilities may include:

- Request routing
- CORS
- Rate limiting
- Request IDs
- Common security headers
- Centralized request logging
- Authentication-related gateway policies

Example routing:

```text
/api/v1/auth/*       -> auth-service
/api/v1/employees/*  -> employee-service
/api/v1/audit/*      -> audit-service
```

---

## Technology Stack

### Frontend

- React
- JavaScript
- React Router
- Axios
- CSS
- Environment-based configuration

The frontend can be incrementally modernized during the refactor without requiring a complete rewrite.

### Backend

- Node.js
- Express.js
- JavaScript
- Mongoose
- JWT
- bcrypt
- REST APIs

### Database

- MongoDB
- Mongoose ODM
- MongoDB Atlas for cloud-hosted production data

### DevOps

- Docker
- Docker Compose
- GitHub Actions
- Terraform

### AWS

Target AWS services include:

- Amazon ECS
- AWS Fargate
- Amazon ECR
- Application Load Balancer
- Amazon S3
- Amazon CloudFront
- AWS Certificate Manager
- Amazon CloudWatch
- AWS Secrets Manager and/or Systems Manager Parameter Store
- Amazon Route 53
- AWS IAM
- Amazon VPC

---

## Repository Structure

The target repository structure is:

```text
worksphere/
|
+-- apps/
|   +-- web/
|       +-- public/
|       +-- src/
|       |   +-- api/
|       |   +-- components/
|       |   +-- features/
|       |   |   +-- auth/
|       |   |   +-- employees/
|       |   |   +-- dashboard/
|       |   +-- layouts/
|       |   +-- pages/
|       |   +-- routes/
|       |   +-- hooks/
|       |   +-- utils/
|       +-- Dockerfile
|       +-- package.json
|
+-- services/
|   +-- auth-service/
|   |   +-- src/
|   |   |   +-- config/
|   |   |   +-- controllers/
|   |   |   +-- middleware/
|   |   |   +-- models/
|   |   |   +-- routes/
|   |   |   +-- services/
|   |   |   +-- utils/
|   |   +-- tests/
|   |   +-- Dockerfile
|   |   +-- package.json
|   |
|   +-- employee-service/
|   |   +-- src/
|   |   +-- tests/
|   |   +-- Dockerfile
|   |   +-- package.json
|   |
|   +-- audit-service/
|       +-- src/
|       +-- tests/
|       +-- Dockerfile
|       +-- package.json
|
+-- gateway/
|   +-- src/
|   +-- Dockerfile
|   +-- package.json
|
+-- infrastructure/
|   +-- terraform/
|       +-- modules/
|       +-- environments/
|           +-- dev/
|           +-- prod/
|
+-- .github/
|   +-- workflows/
|       +-- frontend-ci.yml
|       +-- services-ci.yml
|       +-- deploy.yml
|
+-- docs/
|   +-- architecture/
|   +-- api/
|
+-- docker-compose.yml
+-- .env.example
+-- .gitignore
+-- README.md
+-- LICENSE
```

---

## Domain Model

A simplified employee document can look like:

```json
{
  "_id": "employee-id",
  "employeeNumber": "EMP-000123",
  "firstName": "Jane",
  "lastName": "Doe",
  "email": "jane.doe@example.com",
  "phone": "+1-555-0100",
  "jobTitle": "Software Engineer",
  "department": "Engineering",
  "employmentStatus": "ACTIVE",
  "hireDate": "2026-01-15T00:00:00.000Z",
  "managerId": "manager-id",
  "location": "Chicago",
  "avatarUrl": null,
  "createdAt": "2026-01-15T14:20:00.000Z",
  "updatedAt": "2026-01-15T14:20:00.000Z"
}
```

Example statuses:

```text
ACTIVE
ON_LEAVE
INACTIVE
TERMINATED
```

Domain validation is performed by the backend before persistence.

---

## API Design

WorkSphere APIs use versioned REST endpoints:

```text
/api/v1/...
```

Example success response:

```json
{
  "success": true,
  "data": {
    "id": "employee-id",
    "firstName": "Jane",
    "lastName": "Doe"
  }
}
```

Example error response:

```json
{
  "success": false,
  "error": {
    "code": "EMPLOYEE_NOT_FOUND",
    "message": "Employee was not found."
  }
}
```

Paginated responses should include metadata:

```json
{
  "success": true,
  "data": [],
  "pagination": {
    "page": 1,
    "limit": 20,
    "totalItems": 124,
    "totalPages": 7
  }
}
```

---

## Authentication and Authorization

Authentication uses short-lived JWT access tokens and refresh tokens.

A typical request flow is:

```text
User
 |
 | credentials
 v
Auth Service
 |
 | validate credentials
 | verify password hash
 |
 +----> Access Token
 |
 +----> Refresh Token
```

Protected endpoints validate the caller before executing business operations.

Authorization is role-based.

Example policy:

| Operation | ADMIN | HR_MANAGER | EMPLOYEE |
| --- | :---: | :---: | :---: |
| View employees | Yes | Yes | Limited |
| Create employee | Yes | Yes | No |
| Update employee | Yes | Yes | Limited |
| Delete/deactivate employee | Yes | Limited | No |
| View audit logs | Yes | Limited | No |
| Manage roles | Yes | No | No |

The exact permissions will be finalized during implementation.

---

## Local Development

### Prerequisites

Install:

- Node.js
- npm
- Git
- Docker Desktop
- Docker Compose

MongoDB does not need to be installed locally when using the Docker Compose development environment.

### Clone the Repository

```bash
git clone <your-repository-url>
cd worksphere
```

### Configure Environment Variables

Copy the example configuration:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Update the values required for your environment.

### Start with Docker Compose

The target developer experience is:

```bash
docker compose up --build
```

This will eventually start:

- React frontend
- API Gateway
- Auth Service
- Employee Service
- Audit Service
- MongoDB development dependencies

Stop the environment with:

```bash
docker compose down
```

Remove local volumes when a complete reset is required:

```bash
docker compose down -v
```

---

## Docker

Every independently deployable component has its own `Dockerfile`.

Example production flow:

```text
GitHub
   |
   v
GitHub Actions
   |
   +--> Test
   |
   +--> Build Docker Image
   |
   +--> Scan/validate
   |
   +--> Push to Amazon ECR
   |
   v
Amazon ECS / Fargate
```

Docker Compose provides a reproducible development environment while ECS runs the backend containers in AWS.

---

## Testing

The testing strategy will include multiple layers.

### Backend

- Unit tests
- Controller/service tests
- API integration tests
- Authentication tests
- Authorization tests
- Validation tests
- Error-handling tests

### Frontend

- Component tests
- Page/feature tests
- API-state tests
- Authentication-flow tests

### End-to-End

Critical workflows can eventually be tested with Playwright, including:

```text
Login
  ->
Open employee directory
  ->
Create employee
  ->
Search employee
  ->
Update employee
  ->
Verify changes
```

CI must run automated tests before deployment.

---

## API Documentation

Backend APIs will be documented with OpenAPI/Swagger.

Documentation should describe:

- Available endpoints
- Authentication requirements
- Request bodies
- Query parameters
- Response models
- HTTP status codes
- Validation failures
- Authorization requirements

The Swagger UI URL will be documented here after the API documentation layer is implemented.

---

## CI/CD

GitHub Actions will automate validation and deployment.

### Pull Request / CI Pipeline

```text
Pull Request
     |
     v
Install Dependencies
     |
     v
Lint
     |
     v
Unit Tests
     |
     v
Integration Tests
     |
     v
Build
```

A failed quality gate prevents the deployment workflow from proceeding.

### Deployment Pipeline

```text
Merge to deployment branch
          |
          v
       Tests
          |
          v
   Build Images
          |
          v
    Amazon ECR
          |
          v
   Amazon ECS
          |
          v
 Health Verification
```

Frontend deployment:

```text
React Build
    |
    v
Amazon S3
    |
    v
CloudFront
```

Production AWS authentication from GitHub should use short-lived credentials through GitHub Actions OIDC rather than long-lived AWS access keys where practical.

---

## AWS Deployment Architecture

The target production architecture is:

```text
                         Users
                           |
                         HTTPS
                           |
                           v
                    +--------------+
                    |  CloudFront  |
                    +------+-------+
                           |
                           v
                    +--------------+
                    |  S3 Web App  |
                    +--------------+

                           |
                      API requests
                           |
                           v
                  +-------------------+
                  | Application Load  |
                  |     Balancer      |
                  +---------+---------+
                            |
                 +----------+----------+
                 |          |          |
                 v          v          v
              Auth       Employee    Audit
              Task         Task       Task
                 \          |          /
                  \         |         /
                   +----------------+
                   |  ECS / Fargate |
                   +----------------+

                         |
                         v
                   MongoDB Atlas

Additional AWS services:

Amazon ECR
    -> container registry

CloudWatch
    -> application/container logs and metrics

Secrets Manager / Parameter Store
    -> secrets and runtime configuration

ACM
    -> TLS certificates

Route 53
    -> DNS

IAM
    -> least-privilege AWS permissions
```

Backend services run in containers without requiring EC2 server administration.

---

## Infrastructure as Code

Terraform will provision the AWS infrastructure.

The Terraform configuration will be organized into reusable modules.

Example:

```text
infrastructure/terraform/
|
+-- modules/
|   +-- networking/
|   +-- ecr/
|   +-- ecs/
|   +-- alb/
|   +-- frontend/
|   +-- monitoring/
|   +-- security/
|
+-- environments/
    +-- dev/
    +-- prod/
```

Infrastructure may include:

- VPC
- Public/private subnets
- Route tables
- Security groups
- ECS cluster
- ECS task definitions/services
- ECR repositories
- Application Load Balancer
- S3 bucket
- CloudFront distribution
- IAM roles/policies
- CloudWatch configuration
- Secret references

Sensitive secret values must not be committed to Terraform source files.

---

## Observability

Production services need to be diagnosable.

WorkSphere will implement:

- Structured application logging
- Request correlation IDs
- HTTP request logging
- Error logging
- Health endpoints
- Container health checks
- CloudWatch logs
- CloudWatch metrics
- Operational alarms where appropriate

Example health endpoint:

```text
GET /health
```

Possible response:

```json
{
  "status": "UP",
  "service": "employee-service"
}
```

Sensitive values such as passwords, tokens, and secrets must never be written to logs.

---

## Security

Security is treated as an application and infrastructure concern.

Planned controls include:

- Password hashing with bcrypt
- JWT validation
- Short-lived access tokens
- Refresh-token handling
- Role-based authorization
- Request validation
- CORS configuration
- Security headers
- Rate limiting
- Environment-based secrets
- HTTPS
- Least-privilege IAM
- Protected production databases
- Dependency scanning
- Container-image scanning
- Sanitized logs and error responses

Production secrets must never be committed to Git.

---

## Environment Variables

A future `.env.example` may contain values similar to:

```dotenv
NODE_ENV=development

GATEWAY_PORT=5000
AUTH_SERVICE_PORT=5001
EMPLOYEE_SERVICE_PORT=5002
AUDIT_SERVICE_PORT=5003

AUTH_SERVICE_URL=http://auth-service:5001
EMPLOYEE_SERVICE_URL=http://employee-service:5002
AUDIT_SERVICE_URL=http://audit-service:5003

AUTH_MONGODB_URI=mongodb://localhost:27017/worksphere-auth
EMPLOYEE_MONGODB_URI=mongodb://localhost:27017/worksphere-employees
AUDIT_MONGODB_URI=mongodb://localhost:27017/worksphere-audit

JWT_ACCESS_SECRET=replace-me
JWT_REFRESH_SECRET=replace-me

CLIENT_ORIGIN=http://localhost:3000
```

These names are illustrative and will be synchronized with the actual implementation as the refactor progresses.

Do not commit a populated `.env` file.

---

## Development Roadmap

### Phase 1 — Repository Refactor

- [ ] Rename/refactor project to WorkSphere
- [ ] Establish monorepo directory structure
- [ ] Move existing React application into `apps/web`
- [ ] Extract employee CRUD from the current backend
- [ ] Create Employee Service
- [ ] Introduce consistent configuration
- [ ] Add centralized error handling
- [ ] Add request validation

### Phase 2 — Authentication

- [ ] Create Auth Service
- [ ] Implement password hashing
- [ ] Implement login
- [ ] Implement access tokens
- [ ] Implement refresh tokens
- [ ] Implement logout
- [ ] Add authentication middleware
- [ ] Add RBAC
- [ ] Protect employee operations

### Phase 3 — Frontend

- [ ] Refactor API layer
- [ ] Remove hard-coded backend URLs
- [ ] Add protected routes
- [ ] Build application shell/navigation
- [ ] Build dashboard
- [ ] Build employee directory
- [ ] Build employee detail page
- [ ] Add create/edit employee forms
- [ ] Add search
- [ ] Add sorting
- [ ] Add filters
- [ ] Add pagination
- [ ] Improve loading/error/empty states

### Phase 4 — Gateway and Audit

- [ ] Add API Gateway
- [ ] Centralize external API routing
- [ ] Add request IDs
- [ ] Add rate limiting
- [ ] Create Audit Service
- [ ] Record employee-management activity
- [ ] Add authorized audit-log UI

### Phase 5 — Quality

- [ ] Add unit tests
- [ ] Add integration tests
- [ ] Add frontend tests
- [ ] Add end-to-end tests
- [ ] Add OpenAPI documentation
- [ ] Add linting/formatting
- [ ] Add structured logging
- [ ] Add health checks

### Phase 6 — Containers and CI

- [ ] Dockerize frontend
- [ ] Dockerize gateway
- [ ] Dockerize services
- [ ] Create Docker Compose environment
- [ ] Create frontend CI workflow
- [ ] Create backend/service CI workflow
- [ ] Add image build validation
- [ ] Add dependency/security checks

### Phase 7 — AWS

- [ ] Create Terraform structure
- [ ] Provision networking
- [ ] Create ECR repositories
- [ ] Create ECS/Fargate services
- [ ] Configure Application Load Balancer
- [ ] Deploy React frontend to S3
- [ ] Configure CloudFront
- [ ] Configure MongoDB Atlas connectivity
- [ ] Configure AWS secrets
- [ ] Configure CloudWatch
- [ ] Configure HTTPS
- [ ] Configure domain/DNS
- [ ] Create automated deployment workflow

### Phase 8 — Portfolio Polish

- [ ] Add architecture diagrams
- [ ] Add screenshots
- [ ] Add API examples
- [ ] Add deployment diagram
- [ ] Add live demo URL
- [ ] Add Swagger URL
- [ ] Add CI status badge
- [ ] Document engineering tradeoffs
- [ ] Document major technical challenges

---

## Engineering Decisions

### Why Employee Management Instead of Inventory Management?

The original application already stores and manages user/person records. Refactoring those records into an employee domain allows existing work to be preserved while introducing a more complete business model.

This leaves more development time for architecture, security, testing, cloud deployment, and user experience.

### Why Microservices?

Microservices are used here as an architectural learning and portfolio objective.

The project intentionally begins with only a few meaningful service boundaries rather than creating a separate service for every entity.

The initial boundaries are:

```text
Identity        -> Auth Service
Employees       -> Employee Service
Audit History   -> Audit Service
```

### Why MongoDB?

MongoDB is retained from the existing MERN application, minimizing unnecessary technology churn while allowing each service to own an independent logical data store.

### Why ECS Fargate?

ECS Fargate provides a strong production deployment target for containerized Node.js services without requiring management of EC2 instances or introducing Kubernetes solely for portfolio complexity.

### Why Terraform?

Terraform makes cloud infrastructure reproducible, reviewable, and version-controlled while demonstrating Infrastructure as Code practices.

---

## Future Improvements

Potential later enhancements include:

- Department Service
- Notification Service
- Employee profile images using S3
- Employee CSV import/export
- Email notifications
- Event-driven communication
- Message broker integration
- Redis caching
- Advanced dashboard analytics
- OpenTelemetry tracing
- Multi-factor authentication
- Single sign-on
- Fine-grained permissions
- Soft-delete and retention policies
- Blue/green deployments
- Separate staging environment

These improvements should be introduced only when the core platform is stable and tested.

---

## Project Status

**Status: Active Development / Architecture Refactor**

WorkSphere is currently being transformed from an existing MERN application into the architecture described in this document.

Because the project is under active development, some documented features represent the target architecture and may not yet be available in the current branch.

The roadmap above tracks the intended implementation order.

---

## Contributing

This project is primarily a portfolio and learning project, but suggestions and constructive feedback are welcome.

For significant changes:

1. Create an issue describing the proposed change.
2. Create a feature branch.
3. Implement and test the change.
4. Open a pull request.
5. Ensure CI checks pass before merging.

Example branch names:

```text
feature/employee-service
feature/auth-refresh-token
feature/dashboard
fix/employee-validation
infra/ecs-deployment
```

---

## License

This project is intended for portfolio and educational use.

Add an appropriate open-source license, such as the MIT License, before distributing or accepting external contributions.

---

## Author

**Herve Chendjou**

Software Engineer

WorkSphere is being developed as a portfolio project demonstrating full-stack engineering, backend architecture, microservices, DevOps, Infrastructure as Code, and AWS cloud deployment.

---

## Acknowledgements

WorkSphere began as a MERN user/inventory CRUD application and is being progressively refactored into a production-oriented employee management platform.

The emphasis of the project is not simply feature count, but demonstrating sound engineering decisions, maintainability, security, automation, and deployability.
