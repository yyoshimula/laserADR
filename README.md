# Laser Ablation Debris Stabilizer (LABS)

宇宙デブリをレーザーアブレーションで安定化し、回収軌道へ押し下げるブラウザゲーム。
Orbital debris removal simulator — laser ablation + HCW (Hill-Clohessy-Wiltshire) relative dynamics.

**[▶ Play](https://yyoshimula.github.io/laserADR/)**

## ゲームの目標

回転（タンブリング）するデブリにレーザーパルスを当てて減速・姿勢制御し、地球方向へ押し下げて大気圏で焼却処分する。

### ミッションフロー

| Phase | 目標 | 条件 |
| --- | --- | --- |
| 1. DESPIN | 回転を止める | ANGULAR RATE < 0.16 rad/s |
| 2. STABILIZE | 姿勢を 2 秒キープ | STABILITY 100% |
| 3. REMOVE | 回収軌道へ押し下げる | 下方の点線(GOAL)に到達 |

**失敗条件**: 回転を止めずに高度を下げ切ると "UNCONTROLLED REENTRY" でゲームオーバー。

## 操作

| キー / 入力 | 機能 |
| --- | --- |
| 左クリック / タップ | レーザー発射 |
| 右ドラッグ | 視点回転 |
| `P` / Space | 一時停止 |
| `R` | リセット |
| `T` | ターゲット切替 (DEBRIS / BOX-WING) |

## 物理モデル

- **HCW (Hill-Clohessy-Wiltshire) equations**: チェイサー衛星を原点とする LVLH フレームでの相対運動を記述
- **Laser ablation impulse**: ヒット点の表面法線方向に推力を付与、デブリ表面位置から `r × F` のトルクで姿勢が変化
- **Sun-synchronous orbit**: 高度 600 km、傾斜角 97.8°、LTAN 10:30、β=22°、周期 90 秒（ゲーム時間）
- **Earth texture**: NASA Blue Marble equirectangular をレイトレースで球面サンプリング

## ローカルで動かす

```bash
git clone https://github.com/yyoshimula/laserADR
cd laserADR
python3 -m http.server 8765
```

ブラウザで http://localhost:8765/ を開く。

## ファイル構成

```
index.html        # UI 構造
styles.css        # HUD / オーバーレイの装飾
game.js           # ゲームロジック・物理・描画
earth_texture.jpg # NASA Blue Marble (equirectangular)
```
