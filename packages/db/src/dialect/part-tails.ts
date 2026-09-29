/**
 * THE PART-WORD TAILS, KEYED BY THE PART'S LAST TWO LETTERS. For every word and every part of it
 * from four letters whose stem does not start with the part, the rest of the word is listed under
 * the part's last two letters, under BOTH stores' stemmers: the server's `english` and the device's
 * FTS5 `porter`, over the two system word lists (74 986 words). Generated, never edited: 204 endings,
 * 1 803 entries, 290 distinct tails (the flat list they replace), 11.1 per typed part on average.
 * Regenerate with `node scripts/gen-part-tails.mjs`. A line is an ending, then its tails; a
 * continuation line starts with two spaces.
 */
const TABLE = `
ab le ly led les ling ility leness ilities
ae d s li lis
ai c ng cally
al s ed ly ing ism ity ize isms itis ized izes lied lies ness ities izing lying ization izations
am ent ents
an t ce cy ts ces ess ted tly cies ting tness
at e ed es or ely ing ion ive ors edly ions ives eness ingly ional ively ivity ionals ionally
  iveness ionalism
ay s ed ing ings
ba l ls te ble bly nce ted tes tor lism lize nces ting tion tive tors lized lizes tions bility
  lizing bilities
bb ed ing ings
be d r s ds er nt rs ing ncy nts red ring ncies
bi c cs ng ty ngs lity ngly cation lities
bl e y ed es ing eness
bm ent
bn ess
bo u us
by s ing
ca l ls nt te ble bly lly nce nts ted tes tor lism lity ntly tely ting tion tive tors tions tives
  bility lities tional tively tionally
cc ed ing
ce d r s li ly nt rs ful ive nce ncy nts ous able ably ives ment nces ness nted ntly fully ments
  ncies fulness
ci c es ng sm ty ve ze ble bly ngs sms tis zed zes ngly ties zing bility
cl y
cy ing
da l ls nt te ble bly led lly nce ncy nts ted tes tor bles ling nces ntly ting tion tive tors
  llied llies ncies tions tives bility llying
dd ed ing ings ingly
de d r s ds er nt rs dly ers nce ncy nts red rly ered nces nted ntly ring ering ncies
df ul uls ully ulness
di c cs ng sm ty ve ze ble bly cal ced ngs sms ves zed zer zes cals cate cing city ngly ties zers
  zing cally cated cates cator citis bility cating cation cators zation
dl y ies
dm ent ents
dn ess esses
do us usly
dy s ing
ea l te ble bly lly ted tes ling ting tion tive tions bility
ed s ly
ee d r s ds rs ing ism red able ably ment ring ments
ef ul uls ully ulness
ei c ng sm ty ve ngs ves
el i y is ies
em ent ents ented
en t ce cy ts ces ess ted tly cies tful ting esses tedly tative tfully tingly tatives
eo us usly
er s ed ly ing red ness ring ative
es s sed ses sing
ey s ed ing
fa l ble bly
fe d r s rs red ated ring
ff ed ing ings
fi c cs ng sm cal ced ngs cate cing cally cated cates cating cation cations
fn ess
fu l ls lly lness
fy ing ingly
ga l ls nt te ble bly lly nce nts ted tes tor lity nces ntly ting tion tive tors tions tives
  bility lities tional tively tivity
ge d r s al ds ly nt rs dly ful ing nce ncy nts ous red able ably ment nces ness ntly ring fully
  ments ncies ously ability
gf ul ully ulness
gg ed ing edly ings
gi c cs es ng sm ze ble bly cal ngs sms tis zed zer zes bles ngly zers zing cally bility
gl i y
gm ent ents
gn ess
go u us usly
ha l ls nt te ble nts tes bles nted litis nting
he d r s ds ly rs dly ism red ated ment ring ating ments rness
hf ul uls ully ulness
hi c cs ng sm ze cal ngs sms zed zer zes ngly zers zing cally
hl i y ies
hm ent ents
hn ess
ho us used usly using usness
hy s ing
ia l ls nt te ble bly led lly nce nts ted tes tor bles ling lism lity lize nces ntly tely ting
  tion tive tors lisms lized lizes tions tives bility lities lizing teness tingly tively lization
ib le ly les ility ilities
ic s al ed ly als ate ing ity ally ated ates ator itis ality ately ating ation ative ators ities
  ations
ie d r s ds nt rs dly ing nce ncy nts nces nted ntly ncies nting
if ul ully
ii ng
il ity ities
im ent ents ented enting
in g gs ess gly esses
io n ns us nal ned nals ning usly nally nalism nality ningly usness
is m ms
it i y is ies
iv e es ely ity itis eness ities
iz e ed er es ers ing ation ingly ations
ji ng
jo us
ka ble bly ting tion tive tions tiveness
ke d r s ly rs dly able
kf ul uls ully ulness
ki ng ngs ngly
kk ed ing
kl y ies
km ent ents
kn ess esses
ky s
la nt te ble bly lly nce nts ted tes tor bles nces ntly tely ting tion tive tors tions tives
  bility teness tively tivity
le d r s ds er ly nt rs ers ful ing nce ncy nts red fuls ment nces ness ntly ring ments ncies
  nting mented ntingly
lf ul uls ully ulness
li c s cs ed es ng sm ty ve ze ble bly cal ngs sms tis ves zed zer zes cals cate city ngly ties
  zers zing cally cated cates bility cately cating cation cative cities zation zingly cations
  zations
ll e s y ed er es ic is ant ate ent ers ful ied ies ing ism ity ize ous able ably ance ants ated
  ates ator ence ency ents ered ible ibly ings itis ized izer izes ment ying ables ating ation
  ators ently ering ingly izers izing ments ously ations encies ibility ization
lm ent ents
ln ess esses
lo u us usly usness
ly ing
ma l ls nt te ble bly lly nce ncy nts ted tes tor bles lism lity nces ntly tely ting tion tive
  tors tedly tions tives lities tional tively
me d r s al er ly nt rs dly nce ncy nts red able lies nces ness nted ring nting
mf ul uls ully ulness
mi c cs ng sm ty ze cal ngs sms zed zer zes cals ngly ties zers zing cally zation zations
ml y
mm ed ing ings
mn ess esses
mo us usly usness
my ing
na l ls nt te ble bly lly nce ncy nts ted tes tor bles lism lity lize nces nted ntly tely ting
  tion tive tors lisms lized lizes ncies nting tions tives bility lities lizing tional tively
  bleness tionals lization tionally lizations tionalism
nc e y es ies
ne d r s er ly nt rs ss ate dly ers ity nce nts ous rly ated ates ered ment nces ness ntly ssed
  sses ating ation ering ments ously ssing ations rative
nf ul uls ully ulness
ng s ly
ni c cs ng sm ty ze ble cal ngs sms tis ves zed zer zes cate ngly ties zers zing cally cated cates
  cator cating cation cative cators zation zingly cations zations
nl y
nm ent ents
nn ed ess ing ings ingly
no u us usly
nt s ed ly ful ing edly ness ative fully ingly atives
ny ing
oa ted ting
oe d r s ic rs ing
oi c ng ngs
on s al ed als ess ing ally alism ality esses ingly
or s
ou s sed sly sing sness
oy s ed ing
pa l ls nt te ble bly lly nce ncy nts ted tes tor lity nces ting tion tors ncies tions bility
  lities tional
pe d r s ds nt rs red rly ment ring aling ments rative
pf ul uls ully ulness
pi c cs ng sm ty cal ngs sms cally
pm ent ents
pn ess
pp ed ing ings
py s ing
qi ng
ra l ls nt te ble bly led lly nce nts ted tes tor bles ling lism lity lize nces nted ntly tely
  ting tion tive tors lized lizes lness tions tives bility lities lizing teness tional tively
  bilities lization tionally lizations
re d r s al ds ly nt rs ate dly nce ncy nts ally ates ment nces ness ntly ating ative ement ments
  ncies ements
rf ul uls ully ulness
ri c cs ng sm ty ve ze cal ced cly ngs sms zed zer zes cate cing city ngly ties zers zing cally
  cated cates cator cating cation cators cities zation cations zations
rl y ies ying
rm ent ents
rn ess essed esses essing
ro us usly usness
rr ed ing ings ingly
ry ing ings
sa l ls nt te ble bly led lly nce nts ted tes bles ling lity nces ntly ting tion tive tions tives
  bility ntness tional tionally
se d r s er ly nt rs dly ers ful nce nts ment nces ness nted fully ments nting ntative ntatives
sf ul uls ully ulness
si c cs ng on sm ty ve ze ble bly cal ngs ons tis ves zed zer zes bles ngly oned ties vely vity
  zers zing cally oning bility veness bilities
sl y
sm s ent ents
sn ess esses
ss ed es ing
sy ing
ta l ls nt te ble bly led lly nce ncy nts ted tes tor bled bles ling lism lity lize nces ntly tely
  ting tion tive tors bling lized lizes ncies tions tives bility lizing tingly tional tively
  tionals lization tionally tiveness lizations
te d r s ds er ly nt rs dly ers ful ing nce ncy nts ous red rly ered ment nces ness nted ntly ring
  rred ering fully ments ncies nting ously rring nesses ntedly rative fulness
tf ul uls ully ulness
ti c s cs es ng on sm ti ty ve ze ble bly cal ced ngs ons sms tis ves zed zer zes bles cals cate
  cing city ngly onal oned ties vely vity zers zing cally cated cates cator onals oning vitis
  bility cality cating cation cators onally veness vities zation zingly cations onalism onality
  oningly zations bilities
tl y ying
tm ent ents
tn ess essed esses essing
to r rs us usly usness
tt ed ing edly ings ingly
ty ing
ua l ls te ble led lly nce ted tes lism lity lize nces tely ting tion lized lizes tions lities
  lizing lization lizations
ue d r s ly nt rs ing nce ncy nts red nces ness nted ntly ring ncies
ui ng sm ty ze zed zes ngly ties zing
ul s ly ness
um ent ents ented
uo us usly usness
us ed ly ing ness
va l ls nt te ble bly led lly nce ncy nts ted tes tor nces nted ntly ting tion tive tors ncies
  nting tions tives tional tively
ve d r s ds ly nt rs dly ncy nts red able ment ness nted ring ments ntful nting ntfully
vi c ng sm ty ze ngs tis zed zes ngly ties zing
vo us used usly using usness
vv ed ing
vy ing
wa l ls ble nce nces
we d r s ds nt rs dly red ring
wf ul ully ulness
wi ng ngs ves ngly
wm ent ents
wn ess
xa nt ble nts tion tive tions tives
xe d r s rs dly
xi c cs ng ty ve ble bly cal ngs ves cate ties vely cally cated cates bility cating cation
xn ess
xy ed ing
ya l ls nt ble lly nce nts nces ntly
ye d r s rs
yf ul uls ully ulness
yi ng ngs ngly
ym ent ents
yn ess
za nt ble bly nce tion tions tional
ze d r s rs ment
zi ng ngs ngly
zy ing
`;

function parse(text: string): Readonly<Record<string, readonly string[]>> {
  const out: Record<string, string[]> = {};
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const words = line.trim().split(/\s+/);
    if (line.startsWith("  ")) { current!.push(...words); continue; }
    current = out[words[0]!] = words.slice(1);
  }
  return out;
}

export const PART_WORD_TAILS_BY_ENDING: Readonly<Record<string, readonly string[]>> = parse(TABLE);
