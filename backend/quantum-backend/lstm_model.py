# lstm_model.py
import json
import sys
import yfinance as yf
import numpy as np
import tensorflow as tf
from tensorflow.keras.models import Sequential
from tensorflow.keras.layers import LSTM, Dense
from sklearn.preprocessing import MinMaxScaler

def cargar_datos(simbolo):
    data = yf.download(simbolo, period="1y", interval="1d")
    if data.empty:
        raise ValueError(f"No se pudieron obtener datos para {simbolo}")
    return data['Close'].values.reshape(-1, 1)

def preparar_datos(data, look_back=60):
    scaler = MinMaxScaler(feature_range=(0, 1))
    scaled = scaler.fit_transform(data)
    X, y = [], []
    for i in range(look_back, len(scaled)):
        X.append(scaled[i - look_back:i, 0])
        y.append(scaled[i, 0])
    return np.array(X), np.array(y), scaler

def construir_modelo(input_shape):
    model = Sequential()
    model.add(LSTM(50, return_sequences=False, input_shape=input_shape))
    model.add(Dense(1))
    model.compile(optimizer='adam', loss='mean_squared_error')
    return model

def predecir(simbolo):
    data = cargar_datos(simbolo)
    X, y, scaler = preparar_datos(data)
    X = X.reshape((X.shape[0], X.shape[1], 1))

    model = construir_modelo((X.shape[1], 1))
    model.fit(X, y, epochs=5, batch_size=32, verbose=0)

    ultima_secuencia = X[-1].reshape((1, X.shape[1], 1))
    pred = model.predict(ultima_secuencia, verbose=0)
    precio_esc = scaler.inverse_transform(pred)[0][0]

    precio_actual = float(data[-1])
    porcentaje = ((precio_esc - precio_actual) / precio_actual) * 100

    return {
        "symbol": simbolo,
        "metodo": "LSTM",
        "precio_actual": round(precio_actual, 2),
        "precio_estimado": round(precio_esc, 2),
        "porcentaje": round(porcentaje, 2)
    }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Uso: py -3.9 lstm_model.py <SIMBOLO>"}))
        sys.exit(1)

    simbolo = sys.argv[1]
    try:
        resultado = predecir(simbolo)
        print(json.dumps(resultado))
    except Exception as e:
        print(json.dumps({"error": str(e)}))




