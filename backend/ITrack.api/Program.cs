var builder = WebApplication.CreateBuilder(args);

// Controllers
builder.Services.AddControllers();
builder.Services.Configure<ITrack.api.Services.AdzunaOptions>(
    builder.Configuration.GetSection(ITrack.api.Services.AdzunaOptions.SectionName));
builder.Services.Configure<ITrack.api.Services.SerpApiOptions>(
    builder.Configuration.GetSection(ITrack.api.Services.SerpApiOptions.SectionName));
builder.Services.AddHttpClient<ITrack.api.Services.MarketService>(client =>
{
    client.Timeout = TimeSpan.FromSeconds(25);
});
builder.Services.AddCors(options =>
{
    options.AddPolicy("DevCors", policy =>
    {
        policy
            .AllowAnyHeader()
            .AllowAnyMethod()
            .SetIsOriginAllowed(_ => true);
    });
});

// Swagger
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

var app = builder.Build();

// Enable Swagger in development
if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

// Disable HTTPS redirect for now
// app.UseHttpsRedirection();

app.UseCors("DevCors");
app.UseAuthorization();

app.MapControllers();

app.Run();