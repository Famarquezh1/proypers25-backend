FROM node:20-slim

# Instalar Python3 y pip desde repositorios (mucho más rápido)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    curl \
    wget \
    ca-certificates \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Instalar paquetes Python requeridos (versiones estables y compatibles)
RUN pip3 install --no-cache-dir --break-system-packages \
    yfinance==0.2.36 \
    numpy \
    pandas \
    scikit-learn \
    joblib \
    tensorflow==2.13.0

ENV PYTHON_BIN=/usr/bin/python3

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








