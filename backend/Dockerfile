FROM node:20-slim

# Instalar dependencias para compilar Python
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
    python3-distutils \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Instalar Python 3.9.19 desde fuente
RUN wget https://www.python.org/ftp/python/3.9.19/Python-3.9.19.tgz && \
    tar xzf Python-3.9.19.tgz && \
    cd Python-3.9.19 && \
    ./configure --enable-optimizations && \
    make -j$(nproc) && \
    make altinstall && \
    cd .. && rm -rf Python-3.9.19 Python-3.9.19.tgz

# Configurar python3 y pip3 con update-alternatives (más seguro que ln -s)
RUN update-alternatives --install /usr/bin/python3 python3 /usr/local/bin/python3.9 1 && \
    update-alternatives --install /usr/bin/pip3 pip3 /usr/local/bin/pip3.9 1

# Instalar paquetes Python requeridos (ahora incluye Qiskit)
RUN pip3 install --no-cache-dir yfinance==0.2.36 tensorflow numpy pandas scikit-learn joblib qiskit
RUN python3 -c "import yfinance, numpy, pandas"

ENV PYTHON_BIN=/usr/local/bin/python3.9

# Crear carpeta persistente para los modelos LSTM
RUN mkdir -p /usr/src/app/modelos_lstm

# Carpeta de trabajo para la app Node.js
WORKDIR /usr/src/app

# Instalar dependencias de Node.js
COPY package*.json ./
RUN npm install

# Copiar todo el código del backend
COPY . .

# Exponer el puerto 8080 para Cloud Run
EXPOSE 8080

# Comando para iniciar el servidor
CMD ["node", "server.js"]








