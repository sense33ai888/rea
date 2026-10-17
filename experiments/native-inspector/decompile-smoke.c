__attribute__((visibility("default"), noinline))
int rea_smoke_add(int a, int b) {
  return a + b + 7;
}

int main(void) {
  return rea_smoke_add(2, 3) == 12 ? 0 : 1;
}
