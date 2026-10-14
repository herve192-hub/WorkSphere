# 
# File: front-end/Dockerfile
# 
# Stage 1: Build the React application ...
FROM node:26.10.0-trixie@sha256:9965105b7a4e201d7f07268402bb4971670592b46c9b9058cc643961199a1ab6 AS build


WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# pass API URL at build time ...
ARG REACT_APP_API_URL
ARG CI=false
ENV CI=${CI}
ENV REACT_APP_API_URL=${REACT_APP_API_URL}

RUN npm run build

# Stage 2: Serve the React application with a lightweight web server ...
FROM nginx:1.30.5-alpine3.24@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94

# Copy the build output to the Nginx HTML directory ...
COPY --from=build /app/build /usr/share/nginx/html

#  copie a basic nginx config to support client-side routing ...
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Nginx needs a writable PID path and cache when its master runs without root.
RUN sed -i '/^user[[:space:]]/d; s|/run/nginx.pid|/tmp/nginx.pid|' /etc/nginx/nginx.conf \
    && chown -R nginx:nginx /var/cache/nginx

USER nginx
EXPOSE 8080


CMD ["nginx", "-g",  "daemon off;"]
