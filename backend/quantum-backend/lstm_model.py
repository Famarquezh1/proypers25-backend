# lstm_model.py
import json
import sys
import os
import yfinance as yf
import numpy as np
import tensorflow as tf
from tensorflow.keras.models import Sequential, load_model
from tensorflow.keras.layers import LSTM, Dense
from sklearn.preprocessing import MinMaxScaler
import joblib

tf.config.run_functions_eagerly(True)

def cargar_datos(simbolo):
    data = yf.download(
        simbolo,
        period="1y",
        interval="1d",
        progress=False,
        auto_adjust=False,
        threads=False
    )
    if data.empty or 'Close' not in data:
        ticker = yf.Ticker(simbolo)
        data = ticker.history(period="1y", interval="1d")
    if data.empty or 'Close' not in data:
        raise ValueError(f"No se pudieron obtener datos para {simbolo}")
    close = data['Close'].dropna()
    if close.empty:
        raise ValueError(f"No se pudieron obtener cierres validos para {simbolo}")
    return close.values.reshape(-1, 1)

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
    model.compile(optimizer='adam', loss='mean_squared_error', metrics=['mae'])
    return model

def guardar_modelo_y_scaler(model, scaler, simbolo):
    os.makedirs("modelos_lstm", exist_ok=True)
    model.save(f"modelos_lstm/{simbolo}.h5")
    joblib.dump(scaler, f"modelos_lstm/{simbolo}_scaler.gz")

def cargar_modelo_y_scaler(simbolo):
    model_path = f"modelos_lstm/{simbolo}.h5"
    scaler_path = f"modelos_lstm/{simbolo}_scaler.gz"
    if os.path.exists(model_path) and os.path.exists(scaler_path):
        model = load_model(model_path)
        scaler = joblib.load(scaler_path)
        return model, scaler
    return None, None

def predecir(simbolo):
    data = cargar_datos(simbolo)
    X, y, scaler = preparar_datos(data)
    X = X.reshape((X.shape[0], X.shape[1], 1))

    model, _ = cargar_modelo_y_scaler(simbolo)
    if model is None:
        model = construir_modelo((X.shape[1], 1))
    else:
        # Recompilar el modelo cargado para evitar conflicto con el optimizador
        model.compile(optimizer='adam', loss='mean_squared_error', metrics=['mae'])

    history = model.fit(
        X, y,
        validation_split=0.2,
        epochs=5,
        batch_size=32,
        verbose=0
    )

    error_entrenamiento = float(history.history["loss"][-1])
    val_loss = float(history.history["val_loss"][-1])
    mae = float(history.history["mae"][-1])

    ultima_secuencia = X[-1].reshape((1, X.shape[1], 1))
    pred = model.predict(ultima_secuencia, verbose=0)
    precio_estimado = float(scaler.inverse_transform(pred)[0][0])
    precio_actual = float(data[-1])
    porcentaje = float((precio_estimado - precio_actual) / precio_actual * 100)

    guardar_modelo_y_scaler(model, scaler, simbolo)

    return {
        "symbol": simbolo,
        "metodo": "LSTM",
        "precio_actual": round(precio_actual, 2),
        "precio_estimado": round(precio_estimado, 2),
        "porcentaje": round(porcentaje, 2),
        "error_entrenamiento": round(error_entrenamiento, 6),
        "val_loss": round(val_loss, 6),
        "mae": round(mae, 6)
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
