# lstm_velas.py
import json
import sys
import yfinance as yf
import numpy as np
import tensorflow as tf
from tensorflow.keras.models import Sequential
from tensorflow.keras.layers import LSTM, Dense
from sklearn.preprocessing import MinMaxScaler

def cargar_velas(simbolo, look_back=10):
    df = yf.download(simbolo, period="30d", interval="15m")  # velas 15 minutos
    if df.empty:
        raise ValueError("No se pudieron obtener velas")

    df = df[['Open', 'High', 'Low', 'Close']].copy()

    # Crear etiqueta: 1 si la próxima vela es alcista, 0 si bajista
    df['target'] = (df['Close'].shift(-1) > df['Open'].shift(-1)).astype(int)

    df.dropna(inplace=True)

    X, y = [], []
    for i in range(len(df) - look_back):
        secuencia = df.iloc[i:i+look_back][['Open', 'High', 'Low', 'Close']].values
        etiqueta = df.iloc[i+look_back]['target']
        X.append(secuencia)
        y.append(etiqueta)

    return np.array(X), np.array(y)

def construir_modelo(input_shape):
    model = Sequential()
    model.add(LSTM(50, input_shape=input_shape))
    model.add(Dense(1, activation='sigmoid'))  # Clasificación binaria
    model.compile(optimizer='adam', loss='binary_crossentropy', metrics=['accuracy'])
    return model

def entrenar_modelo(simbolo):
    X, y = cargar_velas(simbolo)
    model = construir_modelo((X.shape[1], X.shape[2]))

    history = model.fit(X, y, epochs=5, batch_size=32, validation_split=0.2, verbose=0)

    loss = float(history.history['loss'][-1])
    val_loss = float(history.history['val_loss'][-1])
    acc = float(history.history['accuracy'][-1])
    val_acc = float(history.history['val_accuracy'][-1])

    # Predecir la dirección de la próxima vela
    ultima_secuencia = X[-1].reshape(1, X.shape[1], X.shape[2])
    pred = model.predict(ultima_secuencia, verbose=0)
    pred_clasificacion = int(pred[0][0] > 0.5)

    return {
        "simbolo": simbolo,
        "metodo": "LSTM_CANDLE",
        "loss": round(loss, 6),
        "val_loss": round(val_loss, 6),
        "accuracy": round(acc * 100, 2),
        "val_accuracy": round(val_acc * 100, 2),
        "prediccion_direccion": "alcista" if pred_clasificacion == 1 else "bajista",
        "confianza": round(pred[0][0] * 100, 2)
    }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Uso: python lstm_velas.py <SIMBOLO>"}))
        sys.exit(1)

    simbolo = sys.argv[1]
    try:
        resultado = entrenar_modelo(simbolo)
        print(json.dumps(resultado))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
