# Usa imagen base oficial
FROM node:20

# Crea y entra a la carpeta de la app
WORKDIR /usr/src/app

# Copia archivos de Node.js
COPY package*.json ./

# Instala dependencias
RUN npm install

# Copia el resto del código
COPY . .

# Expone el puerto 3000
EXPOSE 3000

# Comando para iniciar el backend
CMD ["node", "server.js"]
