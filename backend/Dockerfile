# Usa imagen ligera de Node.js
FROM node:20-slim

# Instala herramientas necesarias para compilar Python y manejar pip
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

# Descarga y compila Python 3.9
RUN wget https://www.python.org/ftp/python/3.9.19/Python-3.9.19.tgz && \
    tar xzf Python-3.9.19.tgz && \
    cd Python-3.9.19 && \
    ./configure --enable-optimizations && \
    make -j$(nproc) && \
    make altinstall && \
    cd .. && rm -rf Python-3.9.19 Python-3.9.19.tgz

# Enlaza python3.9 y pip3.9
RUN ln -s /usr/local/bin/python3.9 /usr/bin/python3 && \
    ln -s /usr/local/bin/pip3.9 /usr/bin/pip3

# Instala dependencias de Python necesarias para tus scripts
RUN pip3 install --no-cache-dir yfinance qiskit pandas

# Crea carpeta de trabajo
WORKDIR /usr/src/app

# Copia e instala dependencias de Node.js
COPY package*.json ./
RUN npm install

# Copia el resto del código (incluyendo scripts Python)
COPY . .

# Exponer puerto 3000 para Cloud Run
EXPOSE 3000

# Comando de inicio
CMD ["node", "server.js"]



