FROM node:26.12.0-alpine3.24@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5 AS base

FROM base AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit

FROM base AS runtime
WORKDIR /app
# npm is needed only to install dependencies, not to run or migrate the API.
# Exclude its dependency tree and command links from the deployed filesystem.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package*.json ./
COPY --chown=node:node server.js ./server.js
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
USER node
EXPOSE 5000
CMD ["node", "server.js"]
