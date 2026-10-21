#include <windows.h>
#include <stdio.h>

struct Meter { int status; int count; };
volatile struct Meter meter = {7, 0};
volatile struct Meter *meterAddress = &meter;
int argumentCount;
char *firstArgument;

void sample(void) {
    meter.status = 9;
    meter.count++;
}

int main(int argc, char **argv) {
    argumentCount = argc;
    firstArgument = argc > 1 ? argv[1] : 0;
    printf("*[hello\npartial");
    fflush(stdout);
    sample();
    while (argc > 1) Sleep(10);
    return 0;
}
