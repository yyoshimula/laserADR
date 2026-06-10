# Laser Ablation Debris Stabilizer (LABS)

宇宙デブリをレーザーアブレーションで安定化し、軌道を下げて処分するブラウザゲーム。
Orbital debris removal simulator — laser ablation + HCW (Hill-Clohessy-Wiltshire) relative dynamics in real SI units.

**[▶ Play](https://yyoshimula.github.io/laserADR/)**

## ゲームの目標

回転（タンブリング）するデブリにレーザーパルスを当てて減速・姿勢制御し、リトログレード(−V)方向の Δv で近地点を目標量だけ下げる（現実のレーザー ADR 構想と同じ「1 パスで数 km の近地点降下 → 複数パス + 大気抵抗で除去」の枠組み）。

### ミッションフロー

| Phase | 目標 | 条件 |
| --- | --- | --- |
| 1. DESPIN | 回転を止める | ANGULAR RATE < 0.16 rad/s |
| 2. STABILIZE | 姿勢を 2 秒キープ | STABILITY 100% |
| 3. REMOVE | 正面(手前向き)の面を撃って逆行方向へ押す | PERIGEE Δ が目標値に到達 |

ポイント: **下(地球側)に押しても軌道は下がらない**。ラジアル方向のインパルスは閉じた 2:1 楕円を描いて 1 周回後に戻ってくるだけ（HCW の基本解）。軌道エネルギーを変えるのは along-track（逆行）方向の Δv のみで、HUD の δa / PERIGEE Δ はその場で反応する。

**失敗条件**:

- タンブリングしたまま近地点目標に到達 → "UNCONTROLLED REENTRY"
- (REALISM) チェイサーの軌道維持燃料が枯渇 → デブリをロスト。相対ドリフトを放置・励起するほどステーションキーピングの燃料を浪費する

## 操作

| キー / 入力 | 機能 |
| --- | --- |
| 左クリック / タップ | レーザー発射 |
| 右ドラッグ | 視点回転 |
| `P` / Space | 一時停止 |
| `R` | リセット |
| `T` | ターゲット切替 (DEBRIS / BOX-WING / ROCKET) |
| `D` | 難易度切替 (EASY / NORMAL / HARD) |
| `M` | 物理モード切替 (REALISM / ARCADE) |

### 物理モード

| Mode | 内容 |
| --- | --- |
| REALISM (既定) | 減衰なしの無損失軌道力学。チェイサー燃料 8 m/s の制約付き |
| ARCADE | 緩い人工減衰 + 燃料無制限のアシストモード |

### ターゲット

| Target | 質量 | 1 パス目標 | 説明 |
| --- | --- | --- | --- |
| DEBRIS | 220 kg | 近地点 −2.0 km | 不定形の岩塊状デブリ。速い自転＋多軸タンブリング。 |
| BOX-WING | 700 kg | 近地点 −0.8 km | 太陽電池パドル付き衛星バス。低速タンブリング。 |
| ROCKET | 2600 kg | 近地点 −0.4 km | 使用済みロケット上段（円筒形）。重く、1 パスで動かせる量が小さい。 |

### 難易度

初期角速度（タンブリング速度）と相対ドリフト速度をスケールする。スコア倍率も連動。

| Level | 角速度 | ドリフト | スコア倍率 |
| --- | --- | --- | --- |
| EASY | ×0.55 | ×0.65 | ×0.7 |
| NORMAL | ×1.0 | ×1.0 | ×1.0 |
| HARD | ×1.7 | ×1.4 | ×1.6 |

## 物理モデル

- **SI 単位の相対軌道力学**: 基準円軌道(高度 600 km、n ≈ 1.085×10⁻³ rad/s)のヒル/LVLH 座標系でデブリの相対状態をメートル/秒で保持。実周期 96.5 分を `TIME_WARP = 64` で約 90 秒/周回にして表示
- **CW 閉形式解(状態遷移行列)**: 毎フレームの伝播は Clohessy-Wiltshire 方程式の解析解で厳密(積分誤差ゼロ)。同じ関数で R–V 面マップの「1 周回先ゴースト予測」を生成
- **軌道要素リードアウト**: δa = 4x + 2ẏ/n(半長軸差)、近地点変化 δr_p = δa − A(A は動径振動振幅)。勝利条件は δr_p ≤ −目標値で、R–V 面の予測軌道がディスポーザル線に届く条件と数学的に同値
- **チェイサーのステーションキーピング**: チェイサー(カメラ)は PD 制御でデブリに追従し、消費 Δv を燃料として表示。REALISM では枯渇 = 失敗
- **Laser ablation impulse**: ヒット面の法線方向にアブレーションジェット、反作用でデブリに −法線方向の推力(コサイン入射則)。推力 0.12 N は文献推定(mN 級)の約 100 倍にスケール(ゲームペーシングのため)。質量(220–2600 kg)と力学は実規模。姿勢回転のみゲーム時間で様式化(幾何・`r × F` トルクの符号は正確)
- **Sun-synchronous orbit**: 高度 600 km、傾斜角 97.8°、LTAN 10:30、β=22°
- **Earth texture**: NASA Blue Marble (8192×4096 equirectangular) をレイトレースで球面サンプリング、バイリニア補間でアンチエイリアシング

改善ロードマップは [docs/IMPROVEMENT_PLAN.md](docs/IMPROVEMENT_PLAN.md) を参照。

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
earth_texture.jpg # NASA Blue Marble (8192x4096 equirectangular, ~6MB)
```
