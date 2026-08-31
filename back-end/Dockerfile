# 
# File: back-end/Dockerfile ...
# 
# node.js lts as base image ...
FROM node:20


# Set the working directory in the container ...
WORKDIR /app


# Copy package.json and package-lock.json to the working directory ...
COPY package*.json ./


# Install dependencies ...
RUN npm install --production

# Copy the rest of the application code to the working directory ...
COPY . .


# Expose the port the app runs on ...
EXPOSE 5000

# Start the application ...
CMD ["node", "server.js"]
