# အလောင်းမင်းတရား — မုဆိုးဘို ၁၇၅၂ (Web Playtest)

ဤ repo သည် GitHub Pages တွင် တင်ထားသော Godot Web export ဖြစ်သည်။ [ဂိမ်းကိုဖွင့်ကစားရန်](./)။ ဤသည် prototype အဆင့် playtest ဖြစ်ပြီး အပြီးသတ် game သို့မဟုတ် native Android app မဟုတ်ပါ။

## ကစားနည်း

- **ဖုန်း/ထိတွေ့မျက်နှာပြင်:** landscape အနေအထားဖြင့်ကစားရန် အကြံပြုသည်။ Portrait ဖြင့်ဖွင့်လျှင် game က landscape mode ကို ကြိုးစားဖွင့်ပေးပြီး မရပါက ဖုန်းကို ကိုယ်တိုင်လှည့်ရန် ပြသမည်။ Browser အချို့တွင် lock သုံးရန် fullscreen ခလုတ်ကို နှိပ်ရနိုင်သည်။ Landscape ဖြစ်သွားလျှင် ဘယ်ဘက် joystick ဖြင့်ရွေ့ပြီး ညာဘက်ရှိ contextual ခလုတ်များကို သုံးပါ။
- **ကွန်ပျူတာ:** `WASD` သို့မဟုတ် မြှားခလုတ်များဖြင့်ရွေ့ပါ။ `Shift` ပြေး၊ `E`/`Space` လုပ်ဆောင်၊ `Q` ရှောင်၊ `B` ကာကွယ်၊ `V` လက်နက်ပြောင်းပါ။

## ပထမဆုံးဖွင့်ချိန်

WebAssembly (`.wasm`) ဖိုင်သည် 39.5 MB ခန့်၊ game data (`.pck`) ဖိုင်သည် 55 MB ခန့်ရှိသည်။ ဖုန်းနှင့်ကွန်ရက်အမြန်နှုန်းပေါ်မူတည်၍ ပထမဆုံးဖွင့်ချိန်တွင် ဒေါင်းလုဒ်နှင့် စတင်တင်ရန် အချိန်ယူနိုင်သည်။ WebAssembly နှင့် WebGL 2 ကို ပံ့ပိုးသော ခေတ်မီ browser ကို အသုံးပြုပါ။

## Public build မှတ်ချက်

ဤ public repo တွင် browser ဖြင့်ကစားရန် လိုအပ်သော Godot Web export ဖိုင်များသာပါဝင်သည်။ Web export ထဲရှိ game data နှင့် browser JavaScript/WASM ဖိုင်များကို download လုပ်ကြည့်ရှုနိုင်သည်။ မူရင်း Godot editor project folder နှင့် native app package ကို ဤ repo တွင် မထည့်ထားပါ။
