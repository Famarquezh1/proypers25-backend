FROM node:20-slim

# Instalar herramientas necesarias
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    wget \
    ca-certificates \
    libssl-dev \
    zlib1g-dev \
    libbz2-dev \
    libreadline-dev \
    libsqlite3-dev \
    libffi-dev \
    libncursesw5-dev \
    xz-utils \
    tk-dev \
    uuid-dev \
    liblzma-dev \
    && rm -rf /var/lib/apt/lists/*

# Descargar, compilar e instalar Python 3.9.19
RUN wget https://www.python.org/ftp/python/3.9.19/Python-3.9.19.tgz && \
    tar xzf Python-3.9.19.tgz && \
    cd Python-3.9.19 && \
    ./configure --enable-optimizations && \
    make -j$(nproc) && \
    make altinstall && \
    ln -s /usr/local/bin/python3.9 /usr/bin/python3.9 && \
    ln -s /usr/local/bin/pip3.9 /usr/bin/pip3.9 && \
    cd .. && rm -rf Python-3.9.19 Python-3.9.19.tgz

# Crear carpeta de trabajo
WORKDIR /usr/src/app

# Instalar dependencias Node.js
COPY package*.json ./
RUN npm install

# Copiar el resto del código (incluyendo scripts Python)
COPY . .

# Exponer puerto para Cloud Run
EXPOSE 3000

# Comando de arranque
CMD ["node", "server.js"]


