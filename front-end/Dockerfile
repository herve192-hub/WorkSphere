# 
# File: front-end/Dockerfile
# 
# Stage 1: Build the React application ...
FROM node:20 AS build


WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# pass API URL at build time ...
ARG REACT_APP_API_URL
ENV REACT_APP_API_URL=${REACT_APP_API_URL}

RUN npm run build

# Stage 2: Serve the React application with a lightweight web server ...
FROM nginx:alpine

# Copy the build output to the Nginx HTML directory ...
COPY --from=build /app/build /usr/share/nginx/html

#  copie a basic nginx config to support client-side routing ...
COPY nginx.conf /etc/nginx/conf.d/default.conf


EXPOSE 80


CMD ["nginx", "-g",  "daemon off;"]