# Base con Node y Python
FROM node:20-slim

# Instala Python 3.9 y pip
RUN apt-get update && \
    apt-get install -y python3.9 python3.9-venv python3.9-distutils curl && \
    curl -sS https://bootstrap.pypa.io/get-pip.py | python3.9

# Establece Python 3.9 como predeterminado
RUN ln -s /usr/bin/python3.9 /usr/bin/python

# Crea directorio para la app
WORKDIR /usr/src/app

# Copia archivos de Node.js
COPY package*.json ./
RUN npm install

# Copia todo (incluyendo scripts Python)
COPY . .

# Expone el puerto
EXPOSE 3000

# Comando para iniciar la app
CMD ["node", "server.js"]

