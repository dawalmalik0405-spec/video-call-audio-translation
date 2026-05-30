# Use an official Python runtime as a parent image
FROM python:3.10-slim

# Set the working directory in the container
WORKDIR /app

# Install system dependencies:
# - curl for downloading Node.js setup script
# - gcc, g++, python3-dev for building C extensions (e.g., webrtcvad)
# - nodejs for the Node.js backend
RUN apt-get update && apt-get install -y \
    curl \
    gcc \
    g++ \
    make \
    python3-dev \
    && curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Copy package files and install Node dependencies
COPY package*.json ./
RUN npm install

# Copy Python requirements and install Python dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application code
COPY . .

# Start the FastAPI app on an internal port (8000).
# The FastAPI startup script will automatically launch the Node.js server.
# Render automatically injects a $PORT environment variable, which the Node.js
# server (server.js) reads and binds to, allowing it to receive public traffic.
CMD ["uvicorn", "translator_fastapi:app", "--host", "0.0.0.0", "--port", "8000"]
